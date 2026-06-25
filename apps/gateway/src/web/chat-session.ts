/**
 * Web chat session routing (web-app §4.1/§4.3). The Web channel reuses the same
 * `routes.json` table as IM (`web:<threadId> → sessionId`), but routing is
 * simpler: the request is already authenticated, so the `accountId` is known
 * directly — it becomes both the memory namespace (cross-channel-memory §3) and
 * the per-account workspace key (§4.3), with no `resolveAccount`/private-chat
 * check needed (a web chat is inherently 1:1 with its account).
 *
 * A `threadId` lets one account keep several independent web conversations.
 */
import { join } from 'node:path';
import type { AgentHost, UserPart } from '@enterprise-agent/agent-contract';
import type { Router } from '../runtime/router.js';

export interface WebTurnInput {
  accountId: string;
  /** Web conversation thread (one account may have many). */
  threadId: string;
  message: string;
  /** Non-text content blocks (images / files, multimodal §6). */
  parts?: UserPart[];
  /** Orchestrator model alias chosen in the UI (web-app §4). */
  model?: string;
  now?: number;
  /** Base dir for per-account workspace isolation (§4.3). */
  workspaceBase?: string;
}

export interface WebTurn {
  sessionId: string;
  runId: string;
  /** True when this turn created a new session (vs continued an existing one). */
  created: boolean;
}

const WEB_CHANNEL = 'web';

/**
 * Resolve (or create) the session for a web turn and submit the message,
 * returning the runId to stream. New sessions are tagged with
 * `memoryNamespace=accountId` so web turns share the account's cross-channel
 * memory (cross-channel-memory §3), and isolated to a per-account workspace.
 */
export async function resolveWebTurn(host: AgentHost, router: Router, input: WebTurnInput): Promise<WebTurn> {
  const now = input.now ?? Date.now();
  const existing = router.lookup(WEB_CHANNEL, input.threadId);
  if (existing) {
    router.touch(WEB_CHANNEL, input.threadId, now);
    if (input.model) await applyModel(host, existing.sessionId, input.model);
    const { runId } = await host.sendMessage(existing.sessionId, input.message, input.parts);
    return { sessionId: existing.sessionId, runId, created: false };
  }
  const started = await host.startSession({
    name: deriveThreadName(input.message),
    workingDir: input.workspaceBase ? join(input.workspaceBase, input.accountId) : undefined,
    goal: input.message,
    parts: input.parts,
    config: input.model
      ? { memoryNamespace: input.accountId, model: { orchestratorAlias: input.model } }
      : { memoryNamespace: input.accountId },
  });
  router.bind(WEB_CHANNEL, input.threadId, started.sessionId, now);
  return { sessionId: started.sessionId, runId: started.runId, created: true };
}

/** Switch an existing session's orchestrator model (read-merge-write its config). */
async function applyModel(host: AgentHost, sessionId: string, alias: string): Promise<void> {
  const all = await host.listSessions();
  const s = all.find((x) => x.id === sessionId);
  if (!s || s.config?.model?.orchestratorAlias === alias) return;
  await host.updateSessionConfig(sessionId, {
    ...s.config,
    model: { ...s.config?.model, orchestratorAlias: alias },
  });
}

function deriveThreadName(text: string): string {
  const first = text.split('\n', 1)[0]!.trim();
  return first.length > 48 ? first.slice(0, 47) + '…' : first || 'Chat';
}
