/**
 * Pipe one orchestrator run's host events into an AI SDK UI message stream
 * (web-app §4.2). Subscribes to the host event bus, filters/encodes events for
 * `runId` via `UiMessageStreamEncoder`, and writes the SSE chunks to a sink.
 * Closes the sink + unsubscribes on `run-finish`/`error` for that run.
 *
 * Kept decoupled from the HTTP layer behind `SseSink` so the streaming logic is
 * unit-testable with a fake host + array sink; the real handler wraps a Node
 * `ServerResponse` in an `SseSink`.
 */
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { UiMessageStreamEncoder } from './ui-message-stream.js';
import type { PendingResponses } from './pending.js';

export interface SseSink {
  write(chunk: string): void;
  close(): void;
}

/** Hooks the stream into the account-scoped pending-response registry (§4.2). */
export interface RunStreamOpts {
  pending?: PendingResponses;
  /** The account that owns this turn — pending suspensions are registered to it. */
  accountId?: string;
  /** The session this run belongs to — gates session-scoped events (todos). */
  sessionId?: string;
}

export interface RunStream {
  /** Resolves once the run finished and the sink was closed. */
  done: Promise<void>;
  /** Tear down early (e.g. the client disconnected): flush finish + close. */
  abort(): void;
}

/** Subscribe to `host` and stream `runId`'s events to `sink` as a UI message stream. */
export function streamRun(
  host: { onEvent(cb: (e: AgentStreamEvent) => void): () => void },
  runId: string,
  sink: SseSink,
  opts: RunStreamOpts = {},
): RunStream {
  const enc = new UiMessageStreamEncoder({ runId, sessionId: opts.sessionId });
  const { pending, accountId } = opts;
  let settled = false;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  const finish = (extra: string[] = []): void => {
    if (settled) return;
    settled = true;
    for (const chunk of extra) sink.write(chunk);
    unsub();
    pending?.clearRun(runId);
    sink.close();
    resolve();
  };

  const unsub = host.onEvent((e) => {
    if (settled) return;
    for (const chunk of enc.onEvent(e)) sink.write(chunk);
    // Register suspensions to the owning account so POST /api/respond can authorize
    // the decision (a run that suspends does NOT emit finish — the stream stays open).
    if (pending && accountId) {
      if (e.kind === 'tool-approval-required' && e.runId === runId)
        pending.register(e.toolCallId, { accountId, kind: 'approval', runId });
      else if (e.kind === 'user-question-required' && e.runId === runId)
        pending.register(e.questionId, { accountId, kind: 'question', runId });
      else if (e.kind === 'plan-proposed' && e.runId === runId)
        pending.register(e.planId, { accountId, kind: 'plan', runId });
    }
    const ev = e as { kind: string; runId?: string };
    if ((ev.kind === 'run-finish' || ev.kind === 'error') && ev.runId === runId) {
      // The encoder already emitted finish + [DONE] for this event; just tear down.
      finish();
    }
  });

  return { done, abort: () => finish(enc.end()) };
}
