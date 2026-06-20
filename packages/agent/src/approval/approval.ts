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
}

export class ApprovalController {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly grants: GrantTable,
    private readonly emitter: ApprovalEmitter,
  ) {}

  /** Gate a high-risk tool call; resolves once a decision is known. */
  async gate(req: GateRequest): Promise<GateResult> {
    const existing = this.grants.match(req.toolName, req.grantKey, req.agentId);
    if (existing) return { mode: 'session-auto', grant: existing };

    this.emitter.emitApprovalRequired(req);

    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(req.toolCallId, { resolve });
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

  /** Host → module: deliver the user's decision (agent §6.1 approveTool). */
  resolve(toolCallId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(toolCallId);
    if (!p) return false;
    this.pending.delete(toolCallId);
    p.resolve(decision);
    return true;
  }

  /** Reject any in-flight approvals (e.g. on abort). */
  rejectAll(): void {
    for (const [, p] of this.pending) p.resolve(APPROVAL.REJECT);
    this.pending.clear();
  }
}
