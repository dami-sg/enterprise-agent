/**
 * Plan controller — the plan-mode twin of QuestionController (runtime/question.ts)
 * and ApprovalController. The model *proposes* a plan via the `exitPlanMode` tool
 * and the run suspends until the user decides. Same bridge:
 *   1. propose() emits `plan-proposed` and suspends on a Promise.
 *   2. the host renders the plan (editable) + the pre-declared actions.
 *   3. host calls resolve(planId, decision, opts); the Promise settles and the
 *      suspended tool applies the decision (switch mode + pre-grant + continue).
 * On abort, cancelAll() rejects any in-flight proposal so the run can unwind.
 */
import type { ExecutionMode, PlanAllowedAction, PlanDecision } from '@enterprise-agent/agent-contract';

export interface PlanProposal {
  runId: string;
  agentId: string;
  parentAgentId?: string;
  /** Correlation id for the decision; the `exitPlanMode` call's toolCallId. */
  planId: string;
  plan: string;
  allowedActions?: PlanAllowedAction[];
}

export type PlanOutcome =
  | { decision: 'approve'; plan: string; targetMode?: ExecutionMode }
  | { decision: 'keep' }
  | { decision: 'reject' };

export interface PlanEmitter {
  emitPlanProposed(req: PlanProposal): void;
}

export class PlanController {
  /** planId → { resolve, plan, dispose } (plan kept so an un-edited approve echoes it back). */
  private pending = new Map<string, { resolve: (o: PlanOutcome) => void; plan: string; dispose: () => void }>();

  constructor(private readonly emitter: PlanEmitter) {}

  /**
   * Propose a plan; resolves once the host delivers a decision.
   *
   * `abortSignal` makes the wait abort-aware, mirroring `ApprovalController.gate`:
   * a report run (whose id isn't the session's `activeRunId`) is never reached by
   * `cancelAll()`, so without listening here an aborted run suspended on a plan
   * proposal would hang forever. On abort we settle as reject so the run unwinds.
   */
  async propose(req: PlanProposal, abortSignal?: AbortSignal): Promise<PlanOutcome> {
    if (abortSignal?.aborted) return { decision: 'reject' };
    this.emitter.emitPlanProposed(req);
    return new Promise<PlanOutcome>((resolve) => {
      const onAbort = (): void => {
        if (this.pending.delete(req.planId)) resolve({ decision: 'reject' });
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(req.planId, {
        resolve,
        plan: req.plan,
        dispose: () => abortSignal?.removeEventListener('abort', onAbort),
      });
    });
  }

  /** Host → module: deliver the user's decision (agent §6.1 approvePlan). */
  resolve(
    planId: string,
    decision: PlanDecision,
    opts?: { editedPlan?: string; targetMode?: ExecutionMode },
  ): boolean {
    const p = this.pending.get(planId);
    if (!p) return false;
    this.pending.delete(planId);
    p.dispose();
    if (decision === 'reject') p.resolve({ decision: 'reject' });
    else if (decision === 'keep') p.resolve({ decision: 'keep' });
    else p.resolve({ decision: 'approve', plan: opts?.editedPlan ?? p.plan, targetMode: opts?.targetMode });
    return true;
  }

  /** Reject any in-flight proposal (e.g. on abort), unblocking the run. */
  cancelAll(): void {
    for (const [, p] of this.pending) {
      p.dispose();
      p.resolve({ decision: 'reject' });
    }
    this.pending.clear();
  }
}
