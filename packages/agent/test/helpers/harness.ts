/**
 * Sub-agent end-to-end test harness. Wires a REAL SessionServices (approval,
 * grants, audit, run/session stores, noop sandbox, accountant, semaphore) around
 * a scripted mock model and injectable MCP/skill providers, so a sub-agent can
 * be driven through an actual ToolLoopAgent run offline and deterministically.
 *
 * This is the missing piece the prior tests never exercised: they unit-tested
 * the helper functions (buildToolsForRole, buildSubResult, …) but never RAN a
 * sub-agent. Here we run one for real and assert it does file r/w, tool calls,
 * network (httpFetch), MCP calls, skill delivery, grant inheritance and approval.
 */
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModel, Tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentStreamEvent, PermissionPolicy } from '@enterprise-agent/agent-contract';
import { ApprovalController, type ApprovalEmitter, type GateRequest } from '../../src/approval/approval.js';
import { GrantTable } from '../../src/approval/grants.js';
import { QuestionController } from '../../src/runtime/question.js';
import { PlanController } from '../../src/runtime/plan.js';
import { AuditStore } from '../../src/storage/audit-store.js';
import { RunStore } from '../../src/storage/run-store.js';
import { SessionStore } from '../../src/storage/session-store.js';
import { Accountant } from '../../src/runtime/accountant.js';
import { ModelMetaRegistry } from '../../src/models/meta.js';
import { NoopSandbox } from '../../src/sandbox/noop.js';
import { EnvKeyStore } from '../../src/config/keychain.js';
import { Semaphore } from '../../src/util/semaphore.js';
import type { ApprovalDecision } from '@enterprise-agent/agent-contract';
import type { RunContext, SessionServices } from '../../src/runtime/context.js';

// ---- scripted mock model ---------------------------------------------------

/** One model turn: emit final text, or emit a single tool call. */
export type ScriptStep =
  | { text: string }
  | { tool: string; input: unknown; id?: string };

const STEP_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function partsFor(step: ScriptStep, i: number): LanguageModelV3StreamPart[] {
  if ('text' in step) {
    const id = `t${i}`;
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: step.text },
      { type: 'text-end', id },
      { type: 'finish', finishReason: 'stop', usage: STEP_USAGE },
    ];
  }
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: step.id ?? `call-${i}`,
      toolName: step.tool,
      input: JSON.stringify(step.input),
    },
    { type: 'finish', finishReason: 'tool-calls', usage: STEP_USAGE },
  ];
}

/**
 * A model that plays a fixed script — one step per doStream call. When the
 * script is exhausted it emits an empty final text (finish 'stop') so a loop
 * never hangs. Each agent (orchestrator / sub) should get its OWN instance.
 */
export function scriptedModel(
  steps: ScriptStep[],
  opts: { provider?: string; modelId?: string } = {},
): MockLanguageModelV3 {
  let n = 0;
  return new MockLanguageModelV3({
    provider: opts.provider ?? 'mock',
    modelId: opts.modelId ?? 'mock-model',
    doStream: async () => {
      const step: ScriptStep = steps[n] ?? { text: '' };
      const parts = partsFor(step, n);
      n += 1;
      return { stream: streamOf(parts) };
    },
  });
}

// ---- services harness ------------------------------------------------------

export interface HarnessOptions {
  /** File boundary for file/exec tools (default: a fresh temp dir). */
  rootPaths?: string[];
  /** Skill roots: read + runnable cwd boundary beyond rootPaths (default: none). */
  skillRoots?: string[];
  /** role → model. Default: every role resolves to `defaultModel`. */
  modelFor?: (role: string) => LanguageModel;
  /** Used when `modelFor` is omitted. */
  defaultModel?: LanguageModel;
  /** Injected MCP tool provider (agent §3.5); default: none. */
  wrapMcpTools?: (ctx: RunContext, allow?: (fq: string) => boolean) => Record<string, Tool>;
  /** Skill catalog for a sub-agent's tool set; default: none. */
  subAgentSkillCatalog?: (toolNames: string[], query?: string) => string;
  /** Backs the `useSkill` tool; default: every name not_found. */
  loadSkill?: (
    name: string,
    allowedToolNames?: string[],
  ) => { name: string; body: string; dir: string } | { error: 'not_found' | 'not_available' };
  /** Backs the `searchSkills` tool; default: no hits. */
  searchSkills?: (query: string, allowedToolNames?: string[]) => { name: string; description: string }[];
  /**
   * Auto-resolve every approval request with this decision (or a function of the
   * request). Omit to leave approvals pending so a test can resolve them itself.
   */
  autoApprove?: ApprovalDecision | ((req: GateRequest) => ApprovalDecision);
  permission?: PermissionPolicy;
  /** Initial execution mode (agent §3.8); default 'ask'. */
  executionMode?: import('@enterprise-agent/agent-contract').ExecutionMode;
  /** Allow network-tier tools during plan exploration (agent §3.8.4); default true. */
  planAllowNetwork?: boolean;
  /** Auto-mode adjudicator stub (agent §3.8.5). `enabled` default true; `classify`
   *  default returns ask (so without a stub, auto behaves like the human gate). */
  auto?: {
    enabled?: boolean;
    classify?: (
      call: import('../../src/runtime/auto-classifier.js').AutoClassifyInput,
    ) => Promise<import('../../src/runtime/auto-classifier.js').AutoClassifierResult>;
  };
  delegateRoles?: string[];
  maxDepth?: number;
  maxConcurrency?: number;
  subAgentTimeoutMs?: number;
}

export interface Harness {
  services: SessionServices;
  /** A depth-0 orchestrator context to spawn sub-agents from. */
  parent: RunContext;
  /** Every emitted stream event (incl. tool-approval-required), in order. */
  events: AgentStreamEvent[];
  /** Approval requests seen by the emitter (the raw GateRequest). */
  gateRequests: GateRequest[];
  approval: ApprovalController;
  grants: GrantTable;
  audit: AuditStore;
  runs: RunStore;
  store: SessionStore;
  rootPaths: string[];
  cleanup(): void;
}

/** Build a fully-wired session-services harness around a scripted model. */
export function makeHarness(opts: HarnessOptions = {}): Harness {
  // realpath so the boundary matches what the file tools' guardPath resolves to
  // (macOS /var → /private/var); otherwise seeded grant keys wouldn't match.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ea-subagent-')));
  const rootPaths = opts.rootPaths ?? [dir];
  const skillRoots = opts.skillRoots ?? [];

  const events: AgentStreamEvent[] = [];
  const emit = (e: AgentStreamEvent): void => {
    events.push(e);
  };

  const grants = new GrantTable();
  const gateRequests: GateRequest[] = [];
  const decideAuto = (req: GateRequest): ApprovalDecision | undefined => {
    if (opts.autoApprove === undefined) return undefined;
    return typeof opts.autoApprove === 'function' ? opts.autoApprove(req) : opts.autoApprove;
  };

  let approval: ApprovalController;
  const emitter: ApprovalEmitter = {
    emitApprovalRequired: (req: GateRequest) => {
      gateRequests.push(req);
      // Mirror the production host's event surface (index.ts assemble()).
      emit({
        kind: 'tool-approval-required',
        runId: req.runId,
        agentId: req.agentId,
        parentAgentId: req.parentAgentId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        input: req.input,
        grantScope: req.grantScope,
      });
      const decision = decideAuto(req);
      if (decision !== undefined) {
        // Resolve on a later microtask: gate() registers `pending` AFTER the
        // emitter returns, so a synchronous resolve would no-op and deadlock.
        queueMicrotask(() => approval.resolve(req.toolCallId, decision));
      }
    },
  };
  approval = new ApprovalController(grants, emitter);

  const meta = new ModelMetaRegistry();
  const audit = new AuditStore(join(dir, 'audit.jsonl'));
  const runs = new RunStore(join(dir, 'runs.jsonl'));
  const store = new SessionStore(join(dir, 'session.jsonl'));
  const accountant = new Accountant(meta);
  const sandbox = new NoopSandbox();
  const sandboxPolicy = sandbox.buildPolicy({ rootPaths });

  const defaultModel = opts.defaultModel ?? scriptedModel([{ text: 'ok' }]);
  const modelFor = opts.modelFor ?? (() => defaultModel);

  let subId = 0;
  let todos: import('@enterprise-agent/agent-contract').Todo[] = [];

  const services: SessionServices = {
    sessionId: 'test-session',
    approval,
    questions: new QuestionController({
      emitQuestionRequired: (req) =>
        emit({
          kind: 'user-question-required',
          runId: req.runId,
          agentId: req.agentId,
          parentAgentId: req.parentAgentId,
          questionId: req.questionId,
          questions: req.questions,
        }),
    }),
    plan: new PlanController({
      emitPlanProposed: (req) =>
        emit({
          kind: 'plan-proposed',
          runId: req.runId,
          agentId: req.agentId,
          parentAgentId: req.parentAgentId,
          planId: req.planId,
          plan: req.plan,
          allowedActions: req.allowedActions,
        }),
    }),
    audit,
    runs,
    session: store,
    accountant,
    sandbox,
    sandboxPolicy,
    meta,
    keychain: new EnvKeyStore(),
    permission: opts.permission ?? {},
    executionMode: { value: opts.executionMode ?? 'ask' },
    planAllowNetwork: opts.planAllowNetwork ?? true,
    auto: {
      enabled: opts.auto?.enabled ?? true,
      classify: async (call) =>
        opts.auto?.classify
          ? opts.auto.classify(call)
          : { verdict: 'ask' as const, reason: 'no classifier stub' },
    },
    rootPaths,
    skillRoots,
    maxDepth: opts.maxDepth ?? 3,
    maxConcurrency: opts.maxConcurrency ?? 4,
    subAgentTimeoutMs: () => opts.subAgentTimeoutMs ?? 0,
    delegateRoles: new Set(opts.delegateRoles ?? []),
    concurrency: new Semaphore(opts.maxConcurrency ?? 4),
    emit,
    setTodos: (next) => {
      todos = next;
    },
    getTodos: () => todos,
    persistUsage: () => {},
    modelFor: (role) => modelFor(role),
    modelRefFor: () => 'mock:mock-model',
    nextSubId: () => (subId += 1),
    wrapMcpTools: (ctx, allow) => (opts.wrapMcpTools ? opts.wrapMcpTools(ctx, allow) : {}),
    subAgentSkillCatalog: (toolNames, query) =>
      opts.subAgentSkillCatalog ? opts.subAgentSkillCatalog(toolNames, query) : '',
    loadSkill: (name, allowed) =>
      opts.loadSkill ? opts.loadSkill(name, allowed) : { error: 'not_found' },
    searchSkills: (query, allowed) => (opts.searchSkills ? opts.searchSkills(query, allowed) : []),
  };

  // The orchestrator turn root: sub-agent transcripts hang under it.
  const rootEntry = store.appendEntry({ agentId: 'orch', kind: 'user', content: [{ type: 'text', text: 'go' }] });
  const orchRun = runs.start({ agentId: 'orch', rootEntryId: rootEntry.id });

  const parent: RunContext = {
    shared: services,
    runId: orchRun.id,
    agentId: 'orch',
    depth: 0,
    rootEntryId: rootEntry.id,
    needsCompaction: { value: false },
    abortSignal: new AbortController().signal,
  };

  return {
    services,
    parent,
    events,
    gateRequests,
    approval,
    grants,
    audit,
    runs,
    store,
    rootPaths,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Invoke the delegateToSubAgent tool's execute directly. */
export async function callDelegate(
  delegateTool: Tool,
  input: Record<string, unknown>,
  toolCallId = 'delegate-1',
): Promise<any> {
  const execute = (delegateTool as { execute?: (...a: unknown[]) => Promise<unknown> }).execute!;
  return execute(input, { toolCallId, messages: [], abortSignal: new AbortController().signal });
}
