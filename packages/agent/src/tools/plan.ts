/**
 * Plan-mode exit tool (agent §3.8.4). The orchestrator calls `exitPlanMode` when
 * its plan is ready; the run suspends on the plan round-trip (PlanController) until
 * the user decides. On approval the tool atomically: switches the session out of
 * plan mode, pre-grants the plan's declared actions, and returns the final plan to
 * the model so execution continues. Orchestrator-scoped (like updateTodos) — not
 * given to sub-agents.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../runtime/context.js';

export function buildPlanTools(ctx: RunContext) {
  const exitPlanMode = tool({
    description:
      'Call ONLY in plan mode, when your plan is ready. Submits the plan (markdown) for the user to ' +
      'review, edit, and approve; until then you stay read-only. Optionally pre-declare the high-risk ' +
      'actions the plan needs (tool + grantKey) so they are auto-approved on execution — the user sees ' +
      'and can strike them. On approval the session leaves plan mode and you execute the plan.',
    inputSchema: z.object({
      plan: z.string().describe('The plan as markdown: goal, approach, step-by-step actions, risks.'),
      allowedActions: z
        .array(
          z.object({
            tool: z.string().describe("Tool name, e.g. 'runCommand' or 'writeFile'."),
            grantKey: z
              .string()
              .describe('Grant scope: argv[0] for runCommand, a directory prefix for writeFile, a host for httpFetch.'),
            reason: z.string().describe('Why the plan needs it.'),
          }),
        )
        .optional()
        .describe('High-risk actions to pre-authorize on approval.'),
    }),
    execute: async ({ plan, allowedActions }, { toolCallId }) => {
      const shared = ctx.shared;
      if (shared.executionMode.value !== 'plan') {
        return {
          error: 'not_in_plan_mode',
          message: 'exitPlanMode only applies in plan mode. You are not in plan mode — just proceed.',
        };
      }

      const outcome = await shared.plan.propose({
        runId: ctx.runId,
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        planId: toolCallId,
        plan,
        allowedActions,
      });

      if (outcome.decision === 'reject') {
        return {
          approved: false,
          decision: 'reject',
          message: 'The user rejected this plan. Stop and wait for new instructions.',
        };
      }
      if (outcome.decision === 'keep') {
        return {
          approved: false,
          decision: 'keep',
          message:
            'The user wants you to keep refining the plan. Continue exploring read-only, then call exitPlanMode again.',
        };
      }

      // Approved: leave plan mode, pre-grant declared actions (agent §3.8.4).
      const targetMode = outcome.targetMode ?? 'ask';
      shared.executionMode.value = targetMode;
      shared.emit({ kind: 'mode-changed', sessionId: shared.sessionId, mode: targetMode });

      const granted: string[] = [];
      for (const a of allowedActions ?? []) {
        shared.approval.grant({ tool: a.tool, grantKey: a.grantKey, agentId: ctx.agentId, agentScoped: false });
        shared.audit.record({
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId,
          tool: a.tool,
          input: { reason: a.reason },
          approval: 'plan-approved',
          grantKey: a.grantKey,
        });
        granted.push(`${a.tool}(${a.grantKey})`);
      }

      return {
        approved: true,
        mode: targetMode,
        plan: outcome.plan,
        preApproved: granted,
        message:
          `Plan approved. Execution mode is now '${targetMode}'. Execute the plan. ` +
          (granted.length ? `Pre-approved (no prompt): ${granted.join(', ')}.` : 'No actions were pre-approved.'),
      };
    },
  });

  return { exitPlanMode };
}
