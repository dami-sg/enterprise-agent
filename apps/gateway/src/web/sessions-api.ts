/**
 * Web sessions + history API (web-app §4.2). Backs the conversation sidebar and
 * transcript load. Both are **account-scoped**: a session belongs to an account
 * iff its `config.memoryNamespace === accountId` (set by resolveWebTurn), so an
 * account can only ever list / read its OWN sessions — the authorization check
 * is structural, not a separate ACL.
 *
 * History is the linear active path (root → head) of the session tree, projected
 * to user/assistant text messages for the frontend.
 */
import type { AgentHost, Entry } from '@enterprise-agent/agent-contract';
import type { Router } from '../runtime/router.js';
import { WEB_CHANNEL, webKeyPrefix } from './chat-session.js';

/** Only the read surface these functions need (keeps them trivially testable). */
type SessionReader = Pick<AgentHost, 'listSessions' | 'getSessionTree'>;

/** True iff `sessionId` exists and belongs to `accountId` (the authorization gate). */
export async function ownsSession(host: Pick<AgentHost, 'listSessions'>, accountId: string, sessionId: string): Promise<boolean> {
  const all = await host.listSessions();
  const s = all.find((x) => x.id === sessionId);
  return !!s && s.config?.memoryNamespace === accountId;
}

/** Rename a session the account owns. Returns false if it doesn't exist / isn't theirs. */
export async function renameAccountSession(
  host: Pick<AgentHost, 'listSessions' | 'renameSession'>,
  accountId: string,
  sessionId: string,
  name: string,
): Promise<boolean> {
  if (!(await ownsSession(host, accountId, sessionId))) return false;
  await host.renameSession(sessionId, name);
  return true;
}

/** Delete a session the account owns, unbinding any web route that pointed at it. */
export async function deleteAccountSession(
  host: Pick<AgentHost, 'listSessions' | 'deleteSession'>,
  router: Router,
  accountId: string,
  sessionId: string,
): Promise<boolean> {
  if (!(await ownsSession(host, accountId, sessionId))) return false;
  await host.deleteSession(sessionId);
  const prefix = webKeyPrefix(accountId);
  for (const { key, entry } of router.entries()) {
    if (key.startsWith(prefix) && entry.sessionId === sessionId) router.unbind(WEB_CHANNEL, key.slice(`${WEB_CHANNEL}:`.length));
  }
  return true;
}

export interface WebSessionSummary {
  sessionId: string;
  /** The web thread this session is bound to (from routes.json), if any. */
  threadId?: string;
  name: string;
}

export interface WebHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** List the account's web sessions (newest session-tree first is the caller's concern). */
export async function listAccountSessions(host: SessionReader, accountId: string, router?: Router): Promise<WebSessionSummary[]> {
  const sessionToThread = router ? webThreadIndex(router, accountId) : new Map<string, string>();
  const all = await host.listSessions();
  return all
    .filter((s) => s.config?.memoryNamespace === accountId)
    .map((s) => ({ sessionId: s.id, name: s.name, threadId: sessionToThread.get(s.id) }));
}

/**
 * Read a session's history as user/assistant messages, or `undefined` if the
 * session doesn't exist OR isn't owned by `accountId` (→ caller responds 404).
 */
export async function readSessionHistory(
  host: SessionReader,
  accountId: string,
  sessionId: string,
): Promise<WebHistoryMessage[] | undefined> {
  if (!(await ownsSession(host, accountId, sessionId))) return undefined; // not found / not yours

  const tree = await host.getSessionTree(sessionId);
  const path: Entry[] = [];
  let cur: string | undefined = tree.headId;
  const guard = new Set<string>(); // cycle guard (defensive)
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const e = tree.nodes[cur];
    if (!e) break;
    path.push(e);
    cur = e.parentId;
  }
  path.reverse();

  return path
    .filter((e) => e.kind === 'user' || e.kind === 'assistant')
    .map((e) => ({ id: e.id, role: e.kind === 'user' ? 'user' : 'assistant', text: entryText(e), ts: e.ts }));
}

/**
 * Reverse this account's web routes to `sessionId → client threadId`. Keys are
 * account-scoped (`web:<accountId>:<threadId>`, see {@link webConversationId});
 * we strip the `web:<accountId>:` prefix so the frontend gets back the bare
 * threadId it originally sent (and never another account's routes).
 */
function webThreadIndex(router: Router, accountId: string): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = webKeyPrefix(accountId);
  for (const { key, entry } of router.entries()) {
    if (key.startsWith(prefix)) out.set(entry.sessionId, key.slice(prefix.length));
  }
  return out;
}

/** Concatenate an entry's text parts (MessagePart is loosely typed). */
function entryText(e: Entry): string {
  if (!e.content) return '';
  return e.content
    .map((p) => {
      const part = p as { type?: string; text?: unknown };
      return part.type === 'text' || typeof part.text === 'string' ? String(part.text ?? '') : '';
    })
    .join('');
}
