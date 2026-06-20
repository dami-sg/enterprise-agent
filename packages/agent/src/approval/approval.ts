/**
 * Three-state approval controller (agent §3.3 / §3.4). Execution lives in the
 * utilityProcess; the UI approval lives in the host. They are bridged by:
 *   1. gate() checks the session grant table → auto-allow on match.
 *   2. otherwise emit `tool-approval-required` and await the host's decision.
 *   3. host calls resolve(toolCallId, decision); SESSION also records a grant.
 */
import { APPROVAL, type ApprovalDecision } from '@enterprise-agent/agent-contract';
import { GrantTable, type Grant } from './grants.js';

export { APPROVAL };
export type { ApprovalDecision };

export interface GateRequest {
  runId: string;
  toolName: string;
  toolCallId: string;
  agentId: string;
  parentAgentId?: string;
  input: unknown;
  /** Meaningful auto-allow scope derived by the tool (agent §3.3). */
  grantKey: string;
  /** Human-readable scope text shown in the dialog. */
  grantScope: string;
  /** Mark grants from this approval as not inheritable by sub-agents. */
  agentScoped?: boolean;
}

export type GateResult =
  | { mode: 'session-auto'; grant: Grant }
  | { mode: 'once' }
  | { mode: 'session'; grant: Grant }
  | { mode: 'reject' };

export interface ApprovalEmitter {
  emitApprovalRequired(req: GateRequest): void;
}

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
  /** Detach the abort listener once the pending entry is settled. */
  dispose: () => void;
}

export class ApprovalController {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly grants: GrantTable,
    private readonly emitter: ApprovalEmitter,
  ) {}

  /**
   * Gate a high-risk tool call; resolves once a decision is known.
   *
   * `abortSignal` (the caller's run signal) makes the wait abort-aware: a
   * sub-agent's wall-clock timeout (agent §2.3) aborts only that sub's combined
   * signal, NOT the session, so it never calls `rejectAll()`. Without listening
   * here, a sub-agent suspended on approval at timeout would hang the
   * orchestrator forever (the SDK awaits the tool's execute, which awaits this
   * promise). On abort we settle as REJECT so the run unwinds — the timeout's
   * documented "never block on a stuck delegation" guarantee actually holds.
   */
  async gate(req: GateRequest, abortSignal?: AbortSignal): Promise<GateResult> {
    const existing = this.grants.match(req.toolName, req.grantKey, req.agentId);
    if (existing) return { mode: 'session-auto', grant: existing };

    // Already torn down (e.g. the run aborted before the call reached the gate):
    // reject without prompting the user for a call that can no longer run.
    if (abortSignal?.aborted) return { mode: 'reject' };

    this.emitter.emitApprovalRequired(req);

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const onAbort = (): void => {
        // Settle only if still pending — a normal resolve() already removed it.
        if (this.pending.delete(req.toolCallId)) resolve(APPROVAL.REJECT);
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(req.toolCallId, {
        resolve,
        dispose: () => abortSignal?.removeEventListener('abort', onAbort),
      });
    });

    if (decision === APPROVAL.REJECT) return { mode: 'reject' };

    if (decision === APPROVAL.SESSION) {
      const grant: Grant = {
        tool: req.toolName,
        grantKey: req.grantKey,
        agentId: req.agentId,
        agentScoped: req.agentScoped ?? false,
      };
      this.grants.add(grant);
      return { mode: 'session', grant };
    }
    return { mode: 'once' };
  }

  /**
   * Pre-authorize a session grant without a prompt (agent §3.8.4): the plan
   * approval flow grants its declared `allowedActions` so they run without a
   * second approval. Bounded by the same grant-key matching as interactive
   * SESSION grants — it does not widen what a key means.
   */
  grant(g: Grant): void {
    this.grants.add(g);
  }

  /** Whether a session grant already covers this call (agent §3.3). Lets the auto
   *  gate honor an existing grant instead of re-classifying (agent §3.8.5). */
  isGranted(tool: string, grantKey: string, agentId: string): boolean {
    return this.grants.match(tool, grantKey, agentId) !== undefined;
  }

  /** Host → module: deliver the user's decision (agent §6.1 approveTool). */
  resolve(toolCallId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(toolCallId);
    if (!p) return false;
    this.pending.delete(toolCallId);
    p.dispose();
    p.resolve(decision);
    return true;
  }

  /**
   * Active delegation (agent §3.4 B): extend a parent's own agent-scoped grants
   * to a spawned child. Bounded by what the parent holds. Returns the delegated
   * grants so the caller can audit them.
   */
  delegateScoped(fromAgentId: string, toAgentId: string): Grant[] {
    return this.grants.delegateScoped(fromAgentId, toAgentId);
  }

  /** Reject any in-flight approvals (e.g. on abort). */
  rejectAll(): void {
    for (const [, p] of this.pending) {
      p.dispose();
      p.resolve(APPROVAL.REJECT);
    }
    this.pending.clear();
  }
}
