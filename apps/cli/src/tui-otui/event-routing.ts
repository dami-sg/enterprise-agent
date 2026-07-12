/**
 * Pure event-routing predicate for the TUI (cli-ui §3.1). Decides whether a
 * stream event belongs to the active turn's run tree and should be rendered.
 *
 * This is the kernel of the mid-run-send deadlock guard: events are filtered by
 * `runId`, so if a new turn were allowed to start while one is in flight it would
 * reassign the tracked `runId` and strand the running turn's remaining events
 * (deltas, tool-result, and crucially tool-approval-required) — an unanswerable
 * approval and an effective deadlock. `send()` refuses a mid-run start to keep
 * this predicate pointed at the one live turn.
 */
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';

export function belongsToActive(
  e: AgentStreamEvent,
  runId: string | undefined,
  subRuns: ReadonlySet<string>,
  sessionId: string | undefined,
): boolean {
  if (e.kind === 'error' && (e.runId === 'mcp' || e.runId === 'sandbox')) return true;
  if (e.kind === 'todo-update') return e.sessionId === sessionId;
  // Admit the active turn's run AND any sub-agent run spawned under it (their
  // events carry the sub-agent's own runId, not the turn's).
  if ('runId' in e) return (runId !== undefined && e.runId === runId) || subRuns.has(e.runId);
  return true;
}
