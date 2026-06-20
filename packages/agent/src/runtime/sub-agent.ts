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

        // Wall-clock timeout (agent §2.3): abort a stuck sub-agent so it cannot
        // block the orchestrator's step forever. The combined signal also feeds
        // the sub's own tool calls (via ctx) so an in-flight httpFetch/MCP call
        // cascade-aborts on timeout. `0` disables the timeout.
        const timeoutMs = parent.shared.subAgentTimeoutMs(role);
        const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
        const abortSignal = timeoutSignal
          ? AbortSignal.any([parent.abortSignal, timeoutSignal])
          : parent.abortSignal;
        const ctx = deriveSubContext(parent, agentId, run.id, abortSignal);

        // Role hard gate (agent §3.4): only role-allowed tools are constructed.
        // Pass the spawner so a role with `delegate: true` can nest-delegate
        // (agent §2.3 pt.2); buildToolsForRole still enforces the depth budget.
        const tools: ToolSet = buildToolsForRole(role as SubAgentRole, ctx, spawnSubAgentTool);
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
        const subMeta = parent.shared.meta.get(modelRef);
        const sub = new ToolLoopAgent({
          model: parent.shared.modelFor(role),
          instructions: SUB_AGENT_PROMPTS[role as SubAgentRole],
          tools,
          stopWhen: stepCountIs(SUB_AGENT_MAX_STEPS),
          maxOutputTokens: subMeta.maxOutputTokens,
        });

        // Record sub-agent usage off the stream's `finish-step` part (the exact
        // provider-reported usage); `totalUsage` is session-wide so the UI's
        // running total includes sub-agent tokens (agent §2.7).
        const recordUsage = (rawUsage: unknown): void => {
          const u = toTokenUsage(rawUsage);
          parent.shared.accountant.record(run.id, agentId, modelRef, u);
          const totals = parent.shared.accountant.workTotals();
          parent.shared.emit({ kind: 'step-finish', runId: run.id, agentId, usage: u });
          parent.shared.emit({
            kind: 'usage',
            runId: run.id,
            agentId,
            usage: u,
            totalUsage: toTokenUsage(totals),
            cost: totals.cost,
            contextWindow: subMeta.contextWindow,
            maxOutputTokens: subMeta.maxOutputTokens,
          });
        };

        // Sub-agent transcript: hang under the turn root WITHOUT moving the
        // active head, so it never pollutes the main session path (agent §5.6).
        const persist = (fallbackText: string): void => {
          parent.shared.session.appendEntry(
            {
              parentId: parent.rootEntryId ?? parent.shared.session.headId,
              runId: run.id,
              agentId,
              kind: 'assistant',
              content: sink.parts.length ? sink.parts : [{ type: 'text', text: fallbackText }],
            },
            { moveHead: false },
          );
        };

        // Stream the sub-agent so its intermediate text / reasoning / tool-call /
        // tool-result reach the trace tree under this agentId (agent §2.3 pt.4).
        const sink = createPartSink();
        try {
          const stream = await sub.stream({
            prompt: [objective, context].filter(Boolean).join('\n\n'),
            abortSignal,
          });
          for await (const part of stream.fullStream as AsyncIterable<StreamPart>) {
            consumeStreamPart(parent.shared.emit, run.id, agentId, part, sink, { onStepUsage: recordUsage });
          }
          const text = await stream.text;
          const steps = (await stream.steps).length;

          persist(text);
          parent.shared.runs.finish(run.id, 'done', 'stop');
          parent.shared.emit({
            kind: 'sub-agent-finish',
            runId: run.id,
            agentId,
            summary: text.slice(0, 500),
          });
          return buildSubResult(role, text, steps);
        } catch (err) {
          // Timeout = our timeout signal fired and it wasn't a session-level
          // abort. Persist the partial transcript and hand the orchestrator a
          // structured result so it can retry / narrow scope instead of blocking.
          if (timeoutSignal?.aborted && !parent.abortSignal.aborted) {
            persist(sink.text);
            parent.shared.runs.finish(run.id, 'error', 'timeout');
            parent.shared.emit({
              kind: 'sub-agent-finish',
              runId: run.id,
              agentId,
              summary: `[timeout after ${timeoutMs}ms] ${sink.text.slice(0, 460)}`,
            });
            return buildTimeoutResult(role, sink.text, timeoutMs);
          }
          // No output: the AI SDK throws `AI_NoOutputGeneratedError` when the run
          // produced no assistant text (e.g. it only called tools, or every tool
          // call errored). Return a structured note + whatever streamed (agent
          // §2.3) instead of rethrowing an opaque "No output generated" — that
          // silent failure is exactly what made delegation look broken.
          if (isNoOutputError(err) && !parent.abortSignal.aborted) {
            persist(sink.text);
            parent.shared.runs.finish(run.id, 'done', 'no-output');
            parent.shared.emit({
              kind: 'sub-agent-finish',
              runId: run.id,
              agentId,
              summary: `[no text output] ${sink.text.slice(0, 460)}`,
            });
            return buildSubResult(role, sink.text, 0);
          }
          // Session-level abort or a genuine error → propagate to the orchestrator.
          parent.shared.runs.finish(run.id, parent.abortSignal.aborted ? 'aborted' : 'error', 'stop');
          throw err;
        }
      } finally {
        release();
      }
    },
  });
}

/**
 * Detect the AI SDK's "no output generated" error (thrown when a run produced no
 * assistant text). Matched by name/message rather than `instanceof` so we don't
 * couple to the SDK's error export.
 */
export function isNoOutputError(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null | undefined;
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  return /NoOutputGenerated/i.test(name) || /no output generated/i.test(message);
}

/** The `delegateToSubAgent` tool result. */
export interface SubAgentResult {
  role: string;
  output: string;
  steps: number;
  /** Set when the sub-agent finished without producing any text. */
  note?: string;
}

/**
 * Shape the sub-agent's tool result. An empty transcript is reported with an
 * explicit `note` rather than a silent `output: ''` — otherwise the orchestrator
 * cannot tell "produced nothing" (e.g. the objective needed a search tool that
 * isn't connected) from a genuine empty answer, and tends to mis-read it as a
 * hang and silently take over (the failure mode behind the blockchain-research
 * run). There is no built-in web_search tool: researchers reach the web only via
 * a connected search MCP server (agent §3.5) or `httpFetch`.
 */
export function buildSubResult(role: string, text: string, steps: number): SubAgentResult {
  if (text.trim()) return { role, output: text, steps };
  return {
    role,
    output: '',
    steps,
    note:
      'The sub-agent finished without producing any text. It likely lacks a tool the ' +
      'objective requires — there is no built-in web_search tool; connect a search MCP ' +
      'server (agent §3.5) or use httpFetch. Do not assume the sub-task succeeded.',
  };
}

/** The `delegateToSubAgent` result when the wall-clock timeout aborted the run. */
export interface SubAgentTimeoutResult {
  role: string;
  /** Partial text streamed before the abort (may be empty). */
  output: string;
  error: 'timeout';
  timeoutMs: number;
  note: string;
}

/**
 * Shape the result for a timed-out sub-agent. The orchestrator sees an explicit
 * `error: 'timeout'` (not a silent empty output) so it can retry, narrow scope,
 * or surface the partial findings — never block on a stuck delegation.
 */
export function buildTimeoutResult(role: string, partialText: string, timeoutMs: number): SubAgentTimeoutResult {
  return {
    role,
    output: partialText,
    error: 'timeout',
    timeoutMs,
    note:
      `The sub-agent was aborted after exceeding the ${timeoutMs}ms timeout. Any text above ` +
      'is partial. Consider narrowing the objective or raising subAgentTimeoutMs.',
  };
}

/** Allocate a fresh agentId for an ad-hoc sub run (used by callers). */
export function freshAgentId(role: string): string {
  return `sub-${role}-${newId('')}`;
}
