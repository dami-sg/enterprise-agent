/**
 * Structured output (agent §2.4). When a Work needs its result persisted as
 * structured data, run an agent with `Output.object`. Note: structured output
 * consumes an extra step, so the step budget must leave room (appendix A).
 */
import { ToolLoopAgent, stepCountIs, Output } from 'ai';
import { z } from 'zod';
import type { RunContext } from './context.js';
import { buildOrchestratorTools } from './orchestrator.js';

/** Default report schema; callers may pass their own. */
export const ReportSchema = z.object({
  summary: z.string(),
  deliverables: z.array(z.object({ title: z.string(), path: z.string() })),
  openQuestions: z.array(z.string()),
});

export type Report = z.infer<typeof ReportSchema>;

export async function generateReport<T extends z.ZodType>(
  ctx: RunContext,
  prompt: string,
  schema: T = ReportSchema as unknown as T,
  maxSteps = 10,
): Promise<z.infer<T>> {
  const agent = new ToolLoopAgent({
    model: ctx.shared.modelFor('orchestrator'),
    tools: buildOrchestratorTools(ctx),
    output: Output.object({ schema }),
    // +1 step over the intended count to account for the structured output step.
    stopWhen: stepCountIs(maxSteps + 1),
  });
  const { output } = await agent.generate({ prompt, abortSignal: ctx.abortSignal });
  return output as z.infer<T>;
}
