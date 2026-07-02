/**
 * Sub-agent orchestration (agent §2.3): Agent-as-Tool. The orchestrator owns a
 * `delegateToSubAgent` tool; calling it spins up a focused ToolLoopAgent with a
 * role-restricted tool set (hard gate) and returns its final output as the tool
 * result. Depth-limited, observable (own agentId), interruptible, concurrency-
 * capped, and subject to the same three-state approval (agent §2.3 / §3.4).
 */
import { ToolLoopAgent, generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import type { SubAgentCapability, SubAgentEvaluation } from '@enterprise-agent/agent-contract';
import { SUB_AGENT_CAPABILITIES } from '@enterprise-agent/agent-contract';
import type { RunContext } from './context.js';
import { deriveSubContext } from './context.js';
import { buildToolsForAgent, mcpAllowedForPolicy, mcpAllowForPolicy, type ToolSet } from '../tools/registry.js';
import { policyFromCapabilities, type AgentDef } from '../agents/registry.js';
import { newId } from '../storage/session-store.js';
import { toTokenUsage, appendUsageEvent } from './usage.js';
import { consumeStreamPart, createPartSink, type StreamPart } from './stream-events.js';
import { telemetryOption } from './telemetry.js';

const SUB_AGENT_MAX_STEPS = 20;

/** Wall-clock cap on the LLM-judge call so evaluation can never hang a turn. */
const JUDGE_TIMEOUT_MS = 20_000;

const JUDGE_SYSTEM =
  'You judge whether a sub-agent met its objective, given the objective and the worker\'s final output. ' +
  'Reply with ONE line in exactly this shape: "MET: <one concise reason>" or "UNMET: <one concise reason>". ' +
  'Judge only goal achievement — not style. If the output is empty, irrelevant, or only restates the task, it is UNMET.';

/** Map a local tool name → the capability token it exercises (eval, §D5). */
const TOOL_CAPABILITY: Record<string, SubAgentCapability> = {
  readFile: 'read',
  listDir: 'read',
  search: 'read',
  writeFile: 'write',
  applyPatch: 'write',
  runCommand: 'exec',
  httpFetch: 'http',
};

/** Sanitize a spec name for use in an agentId (`sub-<name>-<n>`). */
function sanitizeName(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'agent';
}

/**
 * Intersect requested MCP allowlist with the envelope ceiling (dynamic-subagents
 * §D2). `false` requested/ceiling → no MCP; ceiling `true` → exactly what the
 * worker requested (it still enumerates, §D1); two lists → their intersection.
 * Never returns `true`: the worker only ever gets the servers it named.
 */
function intersectMcp(requested: false | string[], ceiling: boolean | string[]): false | string[] {
  if (requested === false || ceiling === false) return false;
  if (ceiling === true) return requested;
  const allow = new Set(ceiling);
  return requested.filter((s) => allow.has(s));
}

/** Capabilities actually exercised (⊆ granted), from the tools the worker called. */
function usedCapabilities(granted: SubAgentCapability[], toolsUsed: Set<string>): SubAgentCapability[] {
  const used = new Set<SubAgentCapability>();
  for (const t of toolsUsed) {
    const c = TOOL_CAPABILITY[t];
    if (c) used.add(c);
  }
  return granted.filter((c) => used.has(c));
}

export function spawnSubAgentTool(parent: RunContext) {
  const env = parent.shared.dynamicSubAgents;
  const capList = SUB_AGENT_CAPABILITIES.join(' | ');
  return tool({
    description:
      'Synthesize a focused, single-use sub-agent for a well-bounded sub-task and run it (dynamic-subagents §D1). ' +
      'You author its capabilities + a task-specific prompt; give it the MINIMUM capability set the task needs — ' +
      'do not round up. The worker runs under your execution mode (no extra approval beyond what the mode already ' +
      'requires), cannot itself delegate, and vanishes when done. Its result is returned to you.\n' +
      `Capability ceiling for this session: [${env.maxCapabilities.join(', ')}]` +
      (env.mcpAllow === false
        ? '; MCP: none.'
        : env.mcpAllow === true
          ? '; MCP: any server (you must still list the ones you need).'
          : `; MCP servers: [${env.mcpAllow.join(', ')}].`) +
      ' Anything you request beyond the ceiling is silently dropped.',
    inputSchema: z.object({
      spec: z
        .object({
          name: z
            .string()
            .describe('Short kebab label for this worker (trace/log only, e.g. "pg-schema-reader").'),
          capabilities: z
            .array(z.enum(SUB_AGENT_CAPABILITIES as unknown as [SubAgentCapability, ...SubAgentCapability[]]))
            .describe(`The minimal capability set the task needs (${capList}).`),
          mcp: z
            .union([z.literal(false), z.array(z.string())])
            .describe('MCP server allowlist (explicit names), or false for none. `true` is not allowed.'),
          prompt: z.string().describe('Task-specific system prompt for the worker.'),
          model: z.string().optional().describe('Model alias or provider:model; omit for the session default.'),
          timeoutMs: z.number().optional().describe('Wall-clock timeout (ms); omit for the session default.'),
        })
        .describe('The synthesized sub-agent definition.'),
      objective: z.string().describe('The explicit goal of the sub-task.'),
      context: z.string().optional().describe('Background needed to do the task.'),
      inheritScopedGrants: z
        .boolean()
        .optional()
        .describe(
          'Let this sub-agent reuse YOUR own session-scoped (sensitive) approvals for the delegated task, so it will not re-prompt for tools you are already approved for. Bounded by what you hold — it never grants more than you have. Default false; shared approvals inherit either way.',
        ),
    }),
    execute: async ({ spec, objective, context, inheritScopedGrants }, { toolCallId }) => {
      // Envelope circuit breaker (dynamic-subagents §D2). Defensive — the tool is
      // not mounted at all when disabled (orchestrator.ts), so this is belt-and-braces.
      if (!env.enabled) {
        return { error: 'dynamic_subagents_disabled' };
      }
      // Nesting is unconditionally banned (dynamic-subagents §D3): a sub-agent
      // never receives this tool, so depth is always 1. Defensive guard only.
      if (parent.depth >= 1) {
        return { error: 'nesting_forbidden' };
      }

      // Capability convergence (dynamic-subagents §D2), fail-closed:
      //   granted = requested ∩ parent ∩ envelope.
      // The parent is the (full-cap) orchestrator, so the binding ceiling is the
      // envelope; out-of-ceiling tokens are silently dropped (子 ≤ 父 preserved).
      const requestedCaps = SUB_AGENT_CAPABILITIES.filter((c) => spec.capabilities.includes(c));
      const grantedCaps = requestedCaps.filter((c) => env.maxCapabilities.includes(c));
      const grantedMcp = intersectMcp(spec.mcp, env.mcpAllow);

      // Wall-clock timeout (agent §2.3): the spec's override, else the envelope
      // default. Resolved once here (a concrete `number`) and reused for both the
      // def and the abort signal below. `0` disables the timeout.
      const timeoutMs = spec.timeoutMs ?? env.defaultTimeoutMs;

      // Build the EPHEMERAL agent def — never registered, vanishes after the run.
      const def: AgentDef = {
        name: spec.name,
        description: '',
        policy: policyFromCapabilities(grantedCaps, grantedMcp),
        prompt: spec.prompt,
        model: spec.model ?? env.defaultModel,
        timeoutMs,
        dir: '<dynamic>',
        builtin: false,
      };
      const name = spec.name;

      const release = await parent.shared.concurrency.acquire();
      // Hoisted so the `finally` can clear it (a const inside the try isn't visible there).
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const subId = parent.shared.nextSubId();
        const agentId = `sub-${sanitizeName(name)}-${subId}`;
        const run = parent.shared.runs.start({
          parentRunId: parent.runId,
          agentId,
        });

        // The combined signal also feeds the sub's own tool calls (via ctx) so an
        // in-flight httpFetch/MCP call cascade-aborts on timeout (see timeoutMs above).
        // Use a manual timer we clear in `finally` rather than `AbortSignal.timeout`,
        // so a fast, clean delegation doesn't leave a live timer/listeners parked for
        // the full timeout window.
        const timeoutCtl = timeoutMs > 0 ? new AbortController() : undefined;
        timeoutTimer = timeoutCtl
          ? setTimeout(() => timeoutCtl.abort(new Error('sub-agent timeout')), timeoutMs)
          : undefined;
        if (timeoutTimer && typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
        const abortSignal = timeoutCtl
          ? AbortSignal.any([parent.abortSignal, timeoutCtl.signal])
          : parent.abortSignal;
        const ctx = deriveSubContext(parent, agentId, run.id, abortSignal);

        // Capability hard gate (agent §3.4): only policy-allowed tools are
        // constructed. NO `delegateFactory` is passed → the worker never gets
        // `delegateToSubAgent`, enforcing the no-nesting ban (§D3) at assembly time.
        const tools: ToolSet = buildToolsForAgent(def, ctx);
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

        // Model: the spec's `model` (or the envelope default) resolved as an
        // explicit alias/ref; otherwise the orchestrator's own model so a worker
        // always runs on a configured, reachable provider (agent §2.6).
        const modelRef = def.model
          ? parent.shared.modelRefForAlias(def.model)
          : parent.shared.orchestratorModelRef();

        // Full-config audit anchor (dynamic-subagents §D4): emit BEFORE start with
        // `requested` vs `granted` so the difference (what the envelope withheld)
        // is recoverable. This event replaces the version-controlled preset roles
        // as the record of what capabilities a worker actually got.
        parent.shared.emit({
          kind: 'sub-agent-spawn',
          runId: run.id,
          parentRunId: parent.runId,
          parentAgentId: parent.agentId,
          agentId,
          name,
          objective,
          requested: { capabilities: requestedCaps, mcp: spec.mcp },
          granted: { capabilities: grantedCaps, mcp: grantedMcp },
          model: modelRef,
          timeoutMs,
          prompt: spec.prompt,
          toolCallId,
        });

        parent.shared.emit({
          kind: 'sub-agent-start',
          runId: run.id,
          parentRunId: parent.runId,
          parentAgentId: parent.agentId,
          agentId,
          role: name,
          toolCallId,
        });

        // Skills the sub-agent can actually carry out with its role tool set
        // (agent §2.3 / §3.6) — appended to the role prompt, mirroring how the
        // orchestrator receives its catalog. The objective seeds the relevance
        // prefetch when in search mode.
        const skillCatalog = parent.shared.subAgentSkillCatalog(Object.keys(tools), objective);
        const instructions = skillCatalog ? `${def.prompt}\n\n${skillCatalog}` : def.prompt;

        const subMeta = parent.shared.meta.get(modelRef);
        const sub = new ToolLoopAgent({
          model: def.model ? parent.shared.modelForAlias(def.model) : parent.shared.orchestratorModel(),
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
        // Capability-usage tracking for the post-run evaluation (dynamic-subagents
        // §D5): which local tools the worker actually called.
        const toolsUsed = new Set<string>();

        // LLM-judge for objective achievement (dynamic-subagents §D5). Fail-open:
        // any missing model / error / timeout returns undefined and the caller
        // keeps the deterministic verdict. Bounded by its own timeout so eval can
        // never hang the turn; its tokens are accounted under this sub-agent.
        const judgeObjective = async (
          outputText: string,
        ): Promise<{ objectiveMet: boolean; reason: string } | undefined> => {
          const alias = env.evaluation.model;
          let jModel;
          let jRef: string;
          try {
            jModel = alias ? parent.shared.modelForAlias(alias) : parent.shared.orchestratorModel();
            jRef = alias ? parent.shared.modelRefForAlias(alias) : parent.shared.orchestratorModelRef();
          } catch {
            return undefined;
          }
          try {
            const judgeAbort = AbortSignal.any([parent.abortSignal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]);
            const { text: verdict, usage } = await generateText({
              model: jModel,
              abortSignal: judgeAbort,
              system: JUDGE_SYSTEM,
              prompt: `Objective:\n${objective}\n\nWorker final output:\n${outputText.slice(0, 4000)}`,
            });
            const u = toTokenUsage(usage);
            const cost = parent.shared.accountant.record(run.id, agentId, jRef, u);
            if (u.inputTokens || u.outputTokens) {
              appendUsageEvent(parent.shared, { ts: Date.now(), runId: run.id, agentId, modelRef: jRef, usage: u, cost });
            }
            const met = /^\s*met\b/i.test(verdict);
            const reason = verdict.replace(/^\s*(met|unmet)\s*:?\s*/i, '').trim();
            return { objectiveMet: met, reason: (reason || verdict).slice(0, 300) };
          } catch {
            return undefined;
          }
        };

        // Post-execution evaluation (dynamic-subagents §D5). The anti-drift
        // `scopeAdherence` + `usedCapabilities` are deterministic (which local
        // tools the worker actually called); objective achievement is judged by an
        // LLM when the run is triggered. Trigger: 'always', or a deterministic
        // failure / over-provision — so the (paid) judge is skipped on the clean
        // path. Result is also returned to the orchestrator for in-session
        // correction (§D7).
        const evaluate = async (outputText: string, errored: boolean): Promise<SubAgentEvaluation | undefined> => {
          if (!env.evaluation.enabled) return undefined;
          const used = usedCapabilities(grantedCaps, toolsUsed);
          const unused = grantedCaps.filter((c) => !used.includes(c));
          const scopeAdherence = unused.length ? 'over-provisioned' : 'ok';
          const detMet = !errored && outputText.trim().length > 0;
          const triggered = env.evaluation.when === 'always' || !detMet || scopeAdherence !== 'ok';
          if (!triggered) return undefined;

          // Refine objective achievement with the judge (when there is output to
          // judge); else keep the deterministic verdict.
          let objectiveMet = detMet;
          let reason = detMet
            ? 'Completed (deterministic).'
            : `Produced no usable output${lastError ? ` (error: ${lastError})` : ''}.`;
          if (outputText.trim()) {
            const judged = await judgeObjective(outputText);
            if (judged) {
              objectiveMet = judged.objectiveMet;
              reason = judged.reason;
            }
          }
          if (unused.length) reason += ` Granted unused capabilities [${unused.join(', ')}] — narrow next time.`;

          const evaluation: SubAgentEvaluation = {
            objectiveMet,
            scopeAdherence,
            usedCapabilities: used,
            steps: stepCount,
            reason,
          };
          parent.shared.emit({ kind: 'sub-agent-eval', runId: run.id, agentId, evaluation });
          return evaluation;
        };

        // Record sub-agent usage off the stream's `finish-step` part (the exact
        // provider-reported usage); `totalUsage` is session-wide so the UI's
        // running total includes sub-agent tokens (agent §2.7).
        const recordUsage = (rawUsage: unknown): void => {
          stepCount++;
          const u = toTokenUsage(rawUsage);
          const cost = parent.shared.accountant.record(run.id, agentId, modelRef, u);
          if (u.inputTokens || u.outputTokens) {
            appendUsageEvent(parent.shared, { ts: Date.now(), runId: run.id, agentId, modelRef, usage: u, cost });
          }
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
            ...telemetryOption('sub-agent', { runId: run.id, agentId }),
          });
          for await (const part of stream.fullStream as AsyncIterable<StreamPart>) {
            if (part.type === 'error') lastError = String(part.error);
            else if (part.type === 'finish') finishReason = (part as { finishReason?: string }).finishReason;
            else if (part.type === 'tool-call') {
              const tn = (part as { toolName?: string }).toolName;
              if (tn) toolsUsed.add(tn);
            }
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
          const evaluation = await evaluate(text, Boolean(lastError));
          return buildSubResult(name, text, stepCount, { error: lastError, finishReason, evaluation });
        } catch (err) {
          // Timeout = our timeout signal fired and it wasn't a session-level
          // abort. Persist the partial transcript and hand the orchestrator a
          // structured result so it can retry / narrow scope instead of blocking.
          if (timeoutCtl?.signal.aborted && !parent.abortSignal.aborted) {
            persist(sink.text);
            parent.shared.runs.finish(run.id, 'error', 'timeout');
            parent.shared.emit({
              kind: 'sub-agent-finish',
              runId: run.id,
              agentId,
              summary: `[timeout after ${timeoutMs}ms] ${sink.text.slice(0, 460)}`,
            });
            return buildTimeoutResult(name, sink.text, timeoutMs);
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
            const evaluation = await evaluate(sink.text, Boolean(lastError));
            return buildSubResult(name, sink.text, stepCount, { error: lastError, finishReason, evaluation });
          }
          // Session-level abort or a genuine error → propagate to the orchestrator.
          parent.shared.runs.finish(run.id, parent.abortSignal.aborted ? 'aborted' : 'error', 'stop');
          throw err;
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
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
  /** The synthesized worker's `spec.name` (dynamic-subagents §D1). */
  role: string;
  output: string;
  steps: number;
  /** Streamed provider/tool error, when one was seen. */
  error?: string;
  /** Set when the sub-agent finished without producing any text. */
  note?: string;
  /** Post-run evaluation (dynamic-subagents §D5), when enabled + triggered. The
   *  orchestrator reads this for in-session correction (§D7). */
  evaluation?: SubAgentEvaluation;
}

/** Diagnostics captured from the sub-agent's stream, used to explain an empty result. */
export interface EmptyOutputDiag {
  error?: string;
  finishReason?: string;
  evaluation?: SubAgentEvaluation;
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
  if (text.trim()) return { role, output: text, steps, ...(diag.evaluation ? { evaluation: diag.evaluation } : {}) };
  return {
    role,
    output: '',
    steps,
    ...(diag.error ? { error: diag.error } : {}),
    note: emptyOutputNote(role, steps, diag),
    ...(diag.evaluation ? { evaluation: diag.evaluation } : {}),
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
