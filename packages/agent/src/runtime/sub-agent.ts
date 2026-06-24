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
import { buildToolsForAgent, mcpAllowedForPolicy, mcpAllowForPolicy, type ToolSet } from '../tools/registry.js';
import { newId } from '../storage/session-store.js';
import { toTokenUsage } from './usage.js';
import { consumeStreamPart, createPartSink, type StreamPart } from './stream-events.js';

const SUB_AGENT_MAX_STEPS = 20;

export function spawnSubAgentTool(parent: RunContext) {
  // Role enum + catalog are derived from the live registry (built-in seeds +
  // discovered AGENT.md) so custom agents are delegable without a code change
  // (§2.3). `names()` always holds the five seeds, so the enum is non-empty.
  const agentNames = parent.shared.agents.names() as [string, ...string[]];
  return tool({
    description:
      'Delegate a well-bounded sub-task to a focused sub-agent. Available agents:\n' +
      parent.shared.agents.catalog() +
      '\nThe sub-agent runs with the chosen agent\'s tool set and returns its result.',
    inputSchema: z.object({
      role: z.enum(agentNames),
      objective: z.string().describe('The explicit goal of the sub-task.'),
      context: z.string().optional().describe('Background needed to do the task.'),
      inheritScopedGrants: z
        .boolean()
        .optional()
        .describe(
          'Let this sub-agent reuse YOUR own session-scoped (sensitive) approvals for the delegated task, so it will not re-prompt for tools you are already approved for. Bounded by what you hold — it never grants more than you have. Default false; shared approvals inherit either way.',
        ),
    }),
    execute: async ({ role, objective, context, inheritScopedGrants }, { toolCallId }) => {
      // Depth guard (agent §2.3 pt.1): disabled beyond MAX_DEPTH.
      if (parent.depth + 1 > parent.shared.maxDepth) {
        return { error: 'max_depth_exceeded', maxDepth: parent.shared.maxDepth };
      }

      // Resolve the chosen agent definition (seed or disk AGENT.md). The z.enum
      // already bounds `role` to a registered name, so this is defensive.
      const def = parent.shared.agents.get(role);
      if (!def) {
        return { error: 'unknown_agent', role, available: parent.shared.agents.names() };
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
        // Per-agent `timeout-ms:` override (declarative def) wins over the
        // role/config default (§2.3, mirrors timeoutForRole precedence).
        const timeoutMs = def.timeoutMs ?? parent.shared.subAgentTimeoutMs(role);
        const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
        const abortSignal = timeoutSignal
          ? AbortSignal.any([parent.abortSignal, timeoutSignal])
          : parent.abortSignal;
        const ctx = deriveSubContext(parent, agentId, run.id, abortSignal);

        // Capability hard gate (agent §3.4): only policy-allowed tools are
        // constructed. Pass the spawner so an agent with `delegate: true` (and
        // admin opt-in) can nest-delegate (agent §2.3 pt.2); buildToolsForAgent
        // still enforces the depth budget.
        const tools: ToolSet = buildToolsForAgent(def, ctx, spawnSubAgentTool);
        if (mcpAllowedForPolicy(def.policy)) {
          // Enforce the per-agent MCP allowlist (agent §3.4) via the predicate.
          Object.assign(tools, parent.shared.wrapMcpTools(ctx, mcpAllowForPolicy(def.policy)));
        }

        // Active grant delegation (agent §3.4 B, opt-in): extend the parent's own
        // agent-scoped approvals to this worker so it won't re-prompt for tools
        // the user already approved for the parent. Bounded by what the parent
        // holds (never escalates); audited under the sub-agent's agentId.
        if (inheritScopedGrants) {
          for (const g of parent.shared.approval.delegateScoped(parent.agentId, agentId)) {
            parent.shared.audit.record({
              runId: run.id,
              agentId,
              toolCallId: `delegated:${g.tool}:${g.grantKey}`,
              tool: g.tool,
              input: { delegatedFrom: parent.agentId },
              approval: 'delegated',
              grantKey: g.grantKey,
              agentScoped: true,
            });
          }
        }

        parent.shared.emit({
          kind: 'sub-agent-start',
          runId: run.id,
          parentRunId: parent.runId,
          parentAgentId: parent.agentId,
          agentId,
          role,
          toolCallId,
        });

        // Skills the sub-agent can actually carry out with its role tool set
        // (agent §2.3 / §3.6) — appended to the role prompt, mirroring how the
        // orchestrator receives its catalog. The objective seeds the relevance
        // prefetch when in search mode.
        const skillCatalog = parent.shared.subAgentSkillCatalog(Object.keys(tools), objective);
        const instructions = skillCatalog ? `${def.prompt}\n\n${skillCatalog}` : def.prompt;

        // Per-agent `model:` override (alias or ref) wins over the role default
        // (§2.3). Resolve ref + model through the same path so cost accounting
        // matches the model actually used.
        const modelRef = def.model ? parent.shared.modelRefForAlias(def.model) : parent.shared.modelRefFor(role);
        const subMeta = parent.shared.meta.get(modelRef);
        const sub = new ToolLoopAgent({
          model: def.model ? parent.shared.modelForAlias(def.model) : parent.shared.modelFor(role),
          instructions,
          tools,
          stopWhen: stepCountIs(SUB_AGENT_MAX_STEPS),
          maxOutputTokens: subMeta.maxOutputTokens,
        });

        // Real diagnostics so an empty result is honest about WHY (not a
        // hardcoded steps:0 + generic "missing web_search" template): count the
        // actual steps the model took, and capture any streamed error / finish
        // reason. These distinguish "model never ran a step" (config) from "ran
        // but emitted no closing text" from "output truncated" (agent §2.3).
        let stepCount = 0;
        let lastError: string | undefined;
        let finishReason: string | undefined;

        // Record sub-agent usage off the stream's `finish-step` part (the exact
        // provider-reported usage); `totalUsage` is session-wide so the UI's
        // running total includes sub-agent tokens (agent §2.7).
        const recordUsage = (rawUsage: unknown): void => {
          stepCount++;
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
            if (part.type === 'error') lastError = String(part.error);
            else if (part.type === 'finish') finishReason = (part as { finishReason?: string }).finishReason;
            consumeStreamPart(parent.shared.emit, run.id, agentId, part, sink, { onStepUsage: recordUsage });
          }
          const text = await stream.text;

          persist(text);
          parent.shared.runs.finish(run.id, 'done', 'stop');
          parent.shared.emit({
            kind: 'sub-agent-finish',
            runId: run.id,
            agentId,
            summary: text.slice(0, 500),
          });
          return buildSubResult(role, text, stepCount, { error: lastError, finishReason });
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
              summary: `[no text output, ${stepCount} step(s)] ${sink.text.slice(0, 440)}`,
            });
            return buildSubResult(role, sink.text, stepCount, { error: lastError, finishReason });
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
  /** Streamed provider/tool error, when one was seen. */
  error?: string;
  /** Set when the sub-agent finished without producing any text. */
  note?: string;
}

/** Diagnostics captured from the sub-agent's stream, used to explain an empty result. */
export interface EmptyOutputDiag {
  error?: string;
  finishReason?: string;
}

/**
 * Build the honest "no text" explanation. Distinguishes the real causes instead
 * of always blaming a missing web_search tool (that template was wrong for e.g.
 * an `analyst` asked to echo "pong"). Precedence: a streamed error → a zero-step
 * run (model never ran: config) → a truncated run (token budget) → ran-but-silent.
 */
function emptyOutputNote(role: string, steps: number, diag: EmptyOutputDiag): string {
  if (diag.error) {
    return `The sub-agent emitted an error and produced no text: ${diag.error}. See its trace under the sub-agent's agentId.`;
  }
  if (steps === 0) {
    return `The sub-agent ran 0 steps and produced no text — the model for role '${role}' did not execute a single step. This points at model/provider config (the role's alias not resolving to a configured, reachable provider), NOT a missing tool.`;
  }
  if (diag.finishReason === 'length') {
    return `The sub-agent hit the output-token limit after ${steps} step(s) before emitting any final text — likely the budget went to reasoning/tool calls. Raise maxOutputTokens for the role, or simplify the objective.`;
  }
  const base = `The sub-agent ran ${steps} step(s) but ended without final text — it likely stopped on a tool call or returned only reasoning. Inspect its trace under the sub-agent's agentId.`;
  return role === 'researcher'
    ? `${base} (If web research was required: there is no built-in web_search tool — connect a search MCP server, agent §3.5.)`
    : base;
}

/**
 * Shape the sub-agent's tool result. An empty transcript is reported with an
 * explicit, cause-specific `note` (and any `error`) rather than a silent
 * `output: ''` — otherwise the orchestrator can't tell "produced nothing" from a
 * genuine empty answer and tends to mis-read it as a hang and take over.
 */
export function buildSubResult(
  role: string,
  text: string,
  steps: number,
  diag: EmptyOutputDiag = {},
): SubAgentResult {
  if (text.trim()) return { role, output: text, steps };
  return {
    role,
    output: '',
    steps,
    ...(diag.error ? { error: diag.error } : {}),
    note: emptyOutputNote(role, steps, diag),
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
