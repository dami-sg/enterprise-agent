/**
 * Account-scoped registry of pending interactive suspensions for the Web channel
 * (web-app §4.2). When an orchestrator run suspends — tool approval, askUserQuestion,
 * or a proposed plan — its correlation id (`toolCallId` / `questionId` / `planId`)
 * is registered here against the account that owns the streaming turn. The
 * `POST /api/respond` handler then `claim`s it before calling the host, so one
 * account can never resolve another account's suspension by guessing an id (the
 * structural analogue of the dispatcher's admin/owner gate, gateway §6.4).
 *
 * Purely in-memory: pending suspensions are inherently live (the run is parked in
 * RAM awaiting a decision); a process restart drops the run anyway.
 */
export type PendingKind = 'approval' | 'question' | 'plan';

interface PendingEntry {
  accountId: string;
  kind: PendingKind;
  /** The orchestrator run this suspension belongs to (for bulk clear on run end). */
  runId: string;
}

export class PendingResponses {
  private readonly byId = new Map<string, PendingEntry>();

  register(id: string, entry: PendingEntry): void {
    this.byId.set(id, entry);
  }

  /**
   * Atomically verify-and-consume a pending response: succeeds only if `id` is
   * registered to `accountId` with the expected `kind`. Removes it on success so
   * a decision can't be replayed.
   */
  claim(id: string, accountId: string, kind: PendingKind): boolean {
    const e = this.byId.get(id);
    if (!e || e.accountId !== accountId || e.kind !== kind) return false;
    this.byId.delete(id);
    return true;
  }

  /** Drop every suspension belonging to a finished/aborted run. */
  clearRun(runId: string): void {
    for (const [id, e] of this.byId) if (e.runId === runId) this.byId.delete(id);
  }
}
