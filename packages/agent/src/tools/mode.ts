/**
 * Execution-mode pre-check (agent §3.8.2). Every mutating tool calls this FIRST —
 * before its own deny/allow fast-paths — so plan-mode read-only lockdown can't be
 * bypassed by a policy allowlist (gate ordering 3 < 4/5). Read-only tools skip it.
 *
 * In 'ask' mode this is a no-op (returns not-blocked), so behavior is byte-identical
 * to before execution modes existed. Plan mode blocks non-readonly tools. Auto mode
 * falls through here for now — the classifier hook (agent §3.8.5) lands in a later
 * phase; until then auto behaves as ask via the downstream approval gate.
 */
import type { RiskTier } from '@dami-sg/agent-contract';
import type { RunContext } from '../runtime/context.js';
import { toolRisk } from './risk.js';

export interface ModeCheck {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

export type ModeResult = { blocked: true; result: unknown } | { blocked: false };

export function enforceMode(ctx: RunContext, call: ModeCheck): ModeResult {
  return enforceModeForTier(ctx, toolRisk(call.toolName), call);
}

/**
 * Plan-mode lockdown keyed by an explicit risk tier. Local tools derive the tier
 * from their name (`enforceMode`); MCP tools have no entry in the local risk
 * table, so they pass their server's configured `riskTier` here — otherwise a
 * mutating MCP tool would slip past the plan-mode read-only guard that blocks the
 * equivalent local `writeFile`/`runCommand`. An unknown/undefined tier is treated
 * as `exec` (fail-closed).
 */
export function enforceModeForTier(ctx: RunContext, tier: RiskTier | undefined, call: ModeCheck): ModeResult {
  const mode = ctx.shared.executionMode.value;

  if (mode === 'plan') {
    const effectiveTier = tier ?? 'exec';
    // Read-only always allowed; network allowed when plan.allowNetwork (research
    // doesn't touch the workspace). Write/exec are blocked.
    const allowed = effectiveTier === 'readonly' || (effectiveTier === 'network' && ctx.shared.planAllowNetwork);
    if (!allowed) {
      ctx.shared.audit.record({
        runId: ctx.runId,
        agentId: ctx.agentId,
        toolCallId: call.toolCallId,
        tool: call.toolName,
        input: call.input,
        approval: 'blocked-plan',
        grantKey: call.toolName,
      });
      return {
        blocked: true,
        result: {
          error: 'plan_mode',
          message:
            'Plan mode is read-only: explore with read-only tools, then call exitPlanMode with your plan ' +
            'to request approval. Execution resumes once the user approves.',
        },
      };
    }
  }

  return { blocked: false };
}
