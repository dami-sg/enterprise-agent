/**
 * Web chat endpoint (web-app §4.2). Ties the pieces together:
 *   authenticate(cookie) → accountId   (else 401)
 *   resolveWebTurn(...)  → session + runId   (routing + memory namespace)
 *   streamRun(runId)     → AI SDK UI message stream over SSE
 *
 * `runChatTurn` is the transport-agnostic core (unit-testable with a fake host +
 * array sink); `handleChatRequest` is the thin Node `http` shell that wraps a
 * `ServerResponse` as an `SseSink`. The endpoint streams the SAME protocol a
 * Vercel ai-chatbot backend does, so the frontend uses `useChat` unchanged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APPROVAL, type AgentHost, type ApprovalDecision, type UserPart, type UserQuestionAnswer } from '@enterprise-agent/agent-contract';
import type { Router } from '../runtime/router.js';
import type { SessionStore } from '../accounts/session-store.js';
import { authenticate } from '../accounts/auth-http.js';
import { resolveWebTurn } from './chat-session.js';
import { streamRun, type SseSink } from './run-stream.js';
import { UI_MESSAGE_STREAM_HEADERS } from './ui-message-stream.js';
import { PendingResponses } from './pending.js';
import { deleteAccountSession, listAccountSessions, readSessionHistory, renameAccountSession } from './sessions-api.js';

export interface WebChatDeps {
  host: AgentHost;
  router: Router;
  sessions: SessionStore;
  /** Base dir for per-account workspace isolation (§4.3). */
  workspaceBase?: string;
  /** Selectable orchestrator model aliases (web-app §4); from the config. */
  listModels?: () => Array<{ alias: string; ref: string }>;
  /** Account-scoped registry of pending interactive suspensions (§4.2). */
  pending?: PendingResponses;
  verbose?: boolean;
  now?: () => number;
}

export interface ChatParams {
  accountId: string;
  threadId: string;
  message: string;
  parts?: UserPart[];
  model?: string;
}

/** Transport-agnostic core: route the turn and start streaming it to `sink`. */
export async function runChatTurn(
  deps: Pick<WebChatDeps, 'host' | 'router' | 'workspaceBase' | 'pending' | 'verbose' | 'now'>,
  params: ChatParams,
  sink: SseSink,
): Promise<{ sessionId: string; runId: string; done: Promise<void> }> {
  const { sessionId, runId } = await resolveWebTurn(deps.host, deps.router, {
    accountId: params.accountId,
    threadId: params.threadId,
    message: params.message,
    parts: params.parts,
    model: params.model,
    workspaceBase: deps.workspaceBase,
    now: deps.now?.(),
  });
  const { done } = streamRun(deps.host, runId, sink, { pending: deps.pending, accountId: params.accountId, sessionId });
  return { sessionId, runId, done };
}

/**
 * Accepts two shapes: the AI SDK `useChat` request (`{ id, messages: UIMessage[] }`,
 * the standard frontend path) and a simple `{ threadId?, message }` (curl / tests).
 * For the AI SDK shape the latest user message's text is the turn input and the
 * chat `id` is the thread.
 */
interface UiPart {
  type: string;
  text?: string;
  /** File part (multimodal): a data URL or remote URL. */
  url?: string;
  data?: string;
  mediaType?: string;
  filename?: string;
}
interface UiMessageLite {
  role?: string;
  parts?: UiPart[];
}
interface ChatRequestBody {
  message?: string;
  threadId?: string;
  id?: string;
  model?: string;
  messages?: UiMessageLite[];
}

const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;

/** Convert AI SDK `file` parts (uploaded → base64 data URLs) to agent UserParts. */
export function toUserParts(parts: Array<{ type: string; url?: string; data?: string; mediaType?: string; filename?: string }>): UserPart[] {
  const out: UserPart[] = [];
  for (const p of parts) {
    if (p.type !== 'file') continue;
    const src = typeof p.url === 'string' ? p.url : typeof p.data === 'string' ? p.data : '';
    const m = DATA_URL_RE.exec(src);
    if (!m) continue; // only inline base64 data URLs supported (browser file uploads)
    const mediaType = p.mediaType ?? m[1]!;
    const data = m[2]!;
    if (mediaType.startsWith('image/')) out.push({ type: 'image', data, mediaType });
    else out.push({ type: 'file', data, mediaType, filename: p.filename });
  }
  return out;
}

function extractMessage(body: ChatRequestBody): { text: string; threadId?: string; parts: UserPart[] } {
  if (typeof body.message === 'string') return { text: body.message.trim(), threadId: body.threadId, parts: [] };
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const lpParts = lastUser?.parts ?? [];
  const text = lpParts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
  return { text, threadId: typeof body.id === 'string' ? body.id : body.threadId, parts: toUserParts(lpParts) };
}

const MAX_BODY = 1024 * 1024; // 1MB — chat messages are small

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Node `http` shell for `POST /api/chat`. */
export async function handleChatRequest(req: IncomingMessage, res: ServerResponse, deps: WebChatDeps): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
    return;
  }
  let body: ChatRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as ChatRequestBody;
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    return;
  }
  const { text: message, threadId: bodyThread, parts } = extractMessage(body);
  if (!message && parts.length === 0) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('empty message');
    return;
  }
  const threadId = bodyThread?.trim() || accountId; // default thread == the account

  res.writeHead(200, UI_MESSAGE_STREAM_HEADERS);
  const sink: SseSink = {
    write: (chunk) => void res.write(chunk),
    close: () => res.end(),
  };
  const model = typeof body.model === 'string' ? body.model : undefined;
  const { done, runId } = await runChatTurn(deps, { accountId, threadId, message, parts, model }, sink);
  // Client disconnect → stop streaming (the run keeps going server-side).
  req.on('close', () => {
    if (!res.writableEnded) deps.host.abortRun(runId);
  });
  await done;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

const APPROVAL_DECISIONS = new Set<ApprovalDecision>([APPROVAL.ONCE, APPROVAL.SESSION, APPROVAL.REJECT]);

interface RespondBody {
  kind?: string;
  id?: string;
  decision?: string;
  answers?: UserQuestionAnswer[] | null;
  approve?: boolean;
}

/** Coerce loosely-typed JSON into the aligned `UserQuestionAnswer[]` (or null = dismiss). */
function parseAnswers(raw: unknown): UserQuestionAnswer[] | null | undefined {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return undefined;
  const out: UserQuestionAnswer[] = [];
  for (const a of raw) {
    const sel = (a as { selected?: unknown })?.selected;
    if (!Array.isArray(sel) || !sel.every((s) => typeof s === 'string')) return undefined;
    out.push({ selected: sel as string[] });
  }
  return out;
}

/**
 * `POST /api/respond` — deliver the user's decision for a pending interactive
 * suspension (tool approval / askUserQuestion / plan, web-app §4.2). The run is
 * parked server-side awaiting it; once delivered the still-open `/api/chat` SSE
 * stream resumes. Authorization is structural: the correlation id must be
 * registered to THIS account in the pending registry (else 409).
 */
export async function handleRespondRequest(req: IncomingMessage, res: ServerResponse, deps: WebChatDeps): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!deps.pending) {
    json(res, 503, { error: 'responses unavailable' });
    return;
  }
  let body: RespondBody;
  try {
    body = JSON.parse(await readBody(req)) as RespondBody;
  } catch {
    json(res, 400, { error: 'bad request' });
    return;
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    json(res, 400, { error: 'missing id' });
    return;
  }

  switch (body.kind) {
    case 'approval': {
      const decision = body.decision as ApprovalDecision;
      if (!APPROVAL_DECISIONS.has(decision)) {
        json(res, 400, { error: 'invalid decision' });
        return;
      }
      if (!deps.pending.claim(id, accountId, 'approval')) {
        json(res, 409, { error: 'no pending approval' });
        return;
      }
      deps.host.approveTool(id, decision);
      json(res, 200, { ok: true });
      return;
    }
    case 'question': {
      const answers = parseAnswers(body.answers);
      if (answers === undefined) {
        json(res, 400, { error: 'invalid answers' });
        return;
      }
      if (!deps.pending.claim(id, accountId, 'question')) {
        json(res, 409, { error: 'no pending question' });
        return;
      }
      deps.host.answerQuestion(id, answers);
      json(res, 200, { ok: true });
      return;
    }
    case 'plan': {
      if (typeof body.approve !== 'boolean') {
        json(res, 400, { error: 'missing approve' });
        return;
      }
      if (!deps.pending.claim(id, accountId, 'plan')) {
        json(res, 409, { error: 'no pending plan' });
        return;
      }
      deps.host.approvePlan(id, body.approve ? 'approve' : 'reject');
      json(res, 200, { ok: true });
      return;
    }
    default:
      json(res, 400, { error: 'invalid kind' });
  }
}

/** `GET /api/models` — selectable orchestrator model aliases (requires auth). */
export function handleModelsRequest(req: IncomingMessage, res: ServerResponse, deps: WebChatDeps): void {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  json(res, 200, { models: deps.listModels?.() ?? [] });
}

/** `GET /api/sessions` — the account's web conversation list. */
export async function handleSessionsRequest(req: IncomingMessage, res: ServerResponse, deps: WebChatDeps): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  json(res, 200, { sessions: await listAccountSessions(deps.host, accountId, deps.router) });
}

/** `GET /api/session/:id/history` — a session's transcript (account-scoped). */
export async function handleHistoryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebChatDeps,
  sessionId: string,
): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const history = await readSessionHistory(deps.host, accountId, sessionId);
  if (!history) {
    json(res, 404, { error: 'not found' });
    return;
  }
  json(res, 200, { sessionId, messages: history });
}

/** `POST /api/session/:id/rename` — rename a session the account owns. */
export async function handleRenameRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebChatDeps,
  sessionId: string,
): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  let name = '';
  try {
    name = String((JSON.parse(await readBody(req)) as { name?: unknown }).name ?? '').trim();
  } catch {
    json(res, 400, { error: 'bad request' });
    return;
  }
  if (!name) {
    json(res, 400, { error: 'empty name' });
    return;
  }
  const ok = await renameAccountSession(deps.host, accountId, sessionId, name);
  json(res, ok ? 200 : 404, ok ? { sessionId, name } : { error: 'not found' });
}

/** `DELETE /api/session/:id` — delete a session the account owns. */
export async function handleDeleteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebChatDeps,
  sessionId: string,
): Promise<void> {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const ok = await deleteAccountSession(deps.host, deps.router, accountId, sessionId);
  json(res, ok ? 200 : 404, ok ? { deleted: sessionId } : { error: 'not found' });
}
