/**
 * Main agent / Orchestrator (agent §2.2). A v6 ToolLoopAgent that drives the
 * "call tool → feed result back → keep reasoning" loop until `stopWhen`.
 */
import { ToolLoopAgent, stepCountIs, type PrepareStepFunction } from 'ai';
import type { RunContext } from './context.js';
import { buildLocalTools, type ToolSet } from '../tools/registry.js';
import { spawnSubAgentTool } from './sub-agent.js';

export interface OrchestratorOptions {
  systemPrompt: string;
  maxSteps: number;
  /** Per-step message rewrite for active compaction (agent §5.5). */
  prepareStep?: PrepareStepFunction<ToolSet>;
}

export function buildOrchestratorTools(ctx: RunContext): ToolSet {
  const tools: ToolSet = { ...buildLocalTools(ctx) };
  // MCP dynamic tools (agent §3.5).
  Object.assign(tools, ctx.shared.wrapMcpTools(ctx));
  // Delegation (agent §2.3) — only while under the depth limit.
  if (ctx.depth < ctx.shared.maxDepth) {
    tools.delegateToSubAgent = spawnSubAgentTool(ctx);
  }
  return tools;
}

export function createOrchestrator(ctx: RunContext, opts: OrchestratorOptions): ToolLoopAgent {
  return new ToolLoopAgent({
    model: ctx.shared.modelFor('orchestrator'),
    instructions: opts.systemPrompt,
    tools: buildOrchestratorTools(ctx),
    stopWhen: stepCountIs(opts.maxSteps),
    prepareStep: opts.prepareStep,
  });
}
