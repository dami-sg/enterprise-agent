/**
 * Sub-agent orchestration (agent §2.3): Agent-as-Tool. The orchestrator owns a
 * `delegateToSubAgent` tool; calling it spins up a focused ToolLoopAgent with a
 * role-restricted tool set (hard gate) and returns its final output as the tool
 * result. Depth-limited, observable (own agentId), interruptible, concurrency-
 * capped, and subject to the same three-state approval (agent §2.3 / §3.4).
 */
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from './context.js';
import { deriveSubContext } from './context.js';
import { buildToolsForRole, mcpAllowedForRole, mcpAllowForRole, type ToolSet } from '../tools/registry.js';
import { SUB_AGENT_PROMPTS, type SubAgentRole } from './prompts.js';
import { newId } from '../storage/session-store.js';
import { toTokenUsage } from './usage.js';
import { consumeStreamPart, createPartSink, type StreamPart } from './stream-events.js';

const SUB_AGENT_MAX_STEPS = 20;

export function spawnSubAgentTool(parent: RunContext) {
  return tool({
    description:
      'Delegate a well-bounded sub-task to a focused sub-agent (research, code generation, analysis, writing). The sub-agent runs with a restricted tool set and returns its result.',
    inputSchema: z.object({
      role: z.enum(['researcher', 'coder', 'analyst', 'writer']),
      objective: z.string().describe('The explicit goal of the sub-task.'),
      context: z.string().optional().describe('Background needed to do the task.'),
    }),
    execute: async ({ role, objective, context }) => {
      // Depth guard (agent §2.3 pt.1): disabled beyond MAX_DEPTH.
      if (parent.depth + 1 > parent.shared.maxDepth) {
        return { error: 'max_depth_exceeded', maxDepth: parent.shared.maxDepth };
      }

      const release = await parent.shared.concurrency.acquire();
      try {
        const subId = parent.shared.nextSubId();
        const agentId = `sub-${role}-${subId}`;
        const run = parent.shared.runs.start({
          parentRunId: parent.runId,
          agentId,
        });
        const ctx = deriveSubContext(parent, agentId, run.id);

        // Role hard gate (agent §3.4): only role-allowed tools are constructed.
        const tools: ToolSet = buildToolsForRole(role as SubAgentRole, ctx);
        if (mcpAllowedForRole(role as SubAgentRole)) {
          // Enforce the per-role MCP allowlist (agent §3.4) via the predicate.
          Object.assign(tools, parent.shared.wrapMcpTools(ctx, mcpAllowForRole(role as SubAgentRole)));
        }

        parent.shared.emit({
          kind: 'sub-agent-start',
          runId: run.id,
          parentAgentId: parent.agentId,
          agentId,
          role,
        });

        const modelRef = parent.shared.modelRefFor(role);
        const sub = new ToolLoopAgent({
          model: parent.shared.modelFor(role),
          instructions: SUB_AGENT_PROMPTS[role as SubAgentRole],
          tools,
          stopWhen: stepCountIs(SUB_AGENT_MAX_STEPS),
        });

        // Stream the sub-agent so its intermediate text / tool-call / tool-
        // result reach the trace tree under this agentId (agent §2.3 pt.4).
        const sink = createPartSink();
        const stream = await sub.stream({
          prompt: [objective, context].filter(Boolean).join('\n\n'),
          abortSignal: ctx.abortSignal,
          onStepFinish: ({ usage }: { usage: unknown }) => {
            const u = toTokenUsage(usage);
            const cost = parent.shared.accountant.record(run.id, agentId, modelRef, u);
            parent.shared.emit({ kind: 'step-finish', runId: run.id, agentId, usage: u });
            parent.shared.emit({
              kind: 'usage',
              runId: run.id,
              agentId,
              usage: u,
              totalUsage: toTokenUsage(parent.shared.accountant.agentTotals(agentId)),
              cost,
            });
          },
        });
        for await (const part of stream.fullStream as AsyncIterable<StreamPart>) {
          consumeStreamPart(parent.shared.emit, run.id, agentId, part, sink);
        }
        const text = await stream.text;
        const steps = (await stream.steps).length;

        // Sub-agent transcript: hang under the turn root WITHOUT moving the
        // active head, so it never pollutes the main session path (agent §5.6).
        parent.shared.session.appendEntry(
          {
            parentId: parent.rootEntryId ?? parent.shared.session.headId,
            runId: run.id,
            agentId,
            kind: 'assistant',
            content: sink.parts.length ? sink.parts : [{ type: 'text', text }],
          },
          { moveHead: false },
        );

        parent.shared.runs.finish(run.id, 'done', 'stop');
        parent.shared.emit({
          kind: 'sub-agent-finish',
          runId: run.id,
          agentId,
          summary: text.slice(0, 500),
        });

        return { role, output: text, steps };
      } finally {
        release();
      }
    },
  });
}

/** Allocate a fresh agentId for an ad-hoc sub run (used by callers). */
export function freshAgentId(role: string): string {
  return `sub-${role}-${newId('')}`;
}
