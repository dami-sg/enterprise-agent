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
  /**
   * Output token reservation from the model's meta (agent §2.6). Passed so the
   * provider caps output and the usable input budget = contextWindow − this.
   */
  maxOutputTokens?: number;
  /** Per-step message rewrite for active compaction (agent §5.5). */
  prepareStep?: PrepareStepFunction<ToolSet>;
}

export function buildOrchestratorTools(ctx: RunContext): ToolSet {
  const tools: ToolSet = { ...buildLocalTools(ctx) };
  // MCP dynamic tools (agent §3.5).
  Object.assign(tools, ctx.shared.wrapMcpTools(ctx));
  // Delegation (dynamic-subagents §D1/§D3): ONLY the orchestrator (depth 0) gets
  // it, and only when the envelope is enabled. Sub-agents never receive it (no
  // nesting), so the whole delegation tree is depth 1.
  if (ctx.depth === 0 && ctx.shared.dynamicSubAgents.enabled) {
    tools.delegateToSubAgent = spawnSubAgentTool(ctx);
  }
  return tools;
}

export function createOrchestrator(ctx: RunContext, opts: OrchestratorOptions): ToolLoopAgent {
  return new ToolLoopAgent({
    model: ctx.shared.orchestratorModel(),
    instructions: opts.systemPrompt,
    tools: buildOrchestratorTools(ctx),
    stopWhen: stepCountIs(opts.maxSteps),
    maxOutputTokens: opts.maxOutputTokens,
    prepareStep: opts.prepareStep,
  });
}
