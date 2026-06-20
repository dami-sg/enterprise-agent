/**
 * @enterprise-agent/agent — public entry. Implements the agent §6 command/event
 * contract (`AgentHost`). A host (desktop utilityProcess, CLI) constructs one
 * host and drives Sessions through it; everything below — runtime, tools,
 * approval, MCP, skills, sandbox, file storage — is internal to this package.
 */
import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  CreateSessionInput,
  ExecutionMode,
  PlanDecision,
  ProviderModelsResult,
  ScopedConfig,
  Session,
  SessionTree,
  StartSessionInput,
  Todo,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';

import { generateText } from 'ai';
import { createPaths, type Paths } from './config/paths.js';
import { ConfigStore, timeoutForRole } from './config/store.js';
import { EnvKeyStore, type KeyStore } from './config/keychain.js';
import { RegistryStore } from './storage/registry-store.js';
import { SessionStore } from './storage/session-store.js';
import { RunStore } from './storage/run-store.js';
import { AuditStore } from './storage/audit-store.js';
import { ModelMetaRegistry } from './models/meta.js';
import { ModelCatalog } from './models/catalog.js';
import { ModelsDevStore } from './models/models-dev.js';
import { ModelRegistry, BUILTIN_FALLBACK_REF } from './models/registry.js';
import { Accountant } from './runtime/accountant.js';
import { GrantTable } from './approval/grants.js';
import { ApprovalController, type ApprovalEmitter, type GateRequest } from './approval/approval.js';
import { QuestionController, type QuestionEmitter, type QuestionRequest } from './runtime/question.js';
import { PlanController, type PlanEmitter, type PlanProposal } from './runtime/plan.js';
import { AutoClassifier } from './runtime/auto-classifier.js';
import { Semaphore } from './util/semaphore.js';
import { SkillRegistry } from './skills/loader.js';
import { McpHub } from './mcp/client.js';
import { LandstripSandbox } from './sandbox/landstrip.js';
import { NoopSandbox } from './sandbox/noop.js';
import { resolveLandstripBinary } from './sandbox/install.js';
import type { Sandbox } from './sandbox/sandbox.js';
import { Session as RuntimeSession } from './runtime/session.js';
import type { SessionServices } from './runtime/context.js';

export interface AgentHostOptions {
  /** App data root; defaults to ENTERPRISE_AGENT_HOME or ~/.enterprise-agent. */
  root?: string;
  /** Secret backend; defaults to env-backed store (agent §4). */
  keychain?: KeyStore;
}

interface LiveSession {
  session: RuntimeSession;
  services: SessionServices;
  store: SessionStore;
  mcpHub: McpHub;
}

const FALLBACK_ORCH_REF = BUILTIN_FALLBACK_REF;

class EnterpriseAgentHost implements AgentHost {
  private readonly paths: Paths;
  private readonly config: ConfigStore;
  private readonly registry: RegistryStore;
  private readonly meta = new ModelMetaRegistry();
  private readonly keychain: KeyStore;
  private readonly catalog: ModelCatalog;
  private readonly modelsDev: ModelsDevStore;
  private readonly listeners = new Set<(e: AgentStreamEvent) => void>();
  private readonly live = new Map<string, LiveSession>();
  /** Resolved sandbox executable (managed pinned binary, else PATH) + warn-once guard (§4.1). */
  private landstripBin?: Promise<string | undefined>;
  private sandboxWarned = false;

  constructor(opts: AgentHostOptions = {}) {
    this.paths = createPaths(opts.root);
    this.config = new ConfigStore(this.paths);
    this.registry = new RegistryStore(this.paths);
    this.keychain = opts.keychain ?? new EnvKeyStore();
    this.catalog = new ModelCatalog(
      (id) => this.paths.modelCache(id),
      this.meta,
      this.keychain,
    );
    // Enrich model metadata (context window / output / pricing) from models.dev
    // so discovered + custom models account correctly (agent §2.6/§2.7). The
    // resolver reads the on-disk cache synchronously; the network refresh is
    // deferred to first real use (openSession / listProviderModels) so merely
    // constructing a host stays side-effect-free.
    this.modelsDev = new ModelsDevStore(this.paths.modelsDevCache);
    this.meta.setExternalResolver(this.modelsDev.resolver());
  }

  // -- events --

  onEvent(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentStreamEvent): void {
    for (const l of this.listeners) l(event);
  }

  // -- session management (agent §1 / §6.1) --

  async listSessions(): Promise<Session[]> {
    return this.registry.listSessions();
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    return this.registry.createSession(input);
  }

  async updateSessionConfig(sessionId: string, config: ScopedConfig): Promise<Session> {
    const s = this.registry.getSession(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    const updated = { ...s, config };
    this.registry.saveSession(updated);
    return updated;
  }

  async renameSession(sessionId: string, name: string): Promise<Session> {
    const s = this.registry.getSession(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);
    const updated = { ...s, name };
    this.registry.saveSession(updated);
    return updated;
  }

  /** Title a session from its first user/assistant exchange (agent §2.4). */
  async generateTitle(sessionId: string): Promise<string> {
    const live = await this.openSession(sessionId);
    const path = live.store.getPath();
    const firstText = (kind: string): string => {
      const e = path.find((x) => x.kind === kind);
      if (!e?.content) return '';
      return e.content
        .filter((p) => {
          const t = (p as { type?: unknown }).type;
          return t === undefined || t === 'text';
        })
        .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
        .join('')
        .trim();
    };
    const user = firstText('user').slice(0, 800);
    const assistant = firstText('assistant').slice(0, 800);
    if (!user && !assistant) return '';
    try {
      const { text } = await generateText({
        model: live.services.modelFor('orchestrator'),
        system:
          '为下面的对话生成一个简短标题：用一个完整、通顺的短语概括用户的核心意图，尽量精炼（理想 4-8 个字，约 2-4 个英文词），绝不要截断成不通顺的片段。只输出标题本身，不要任何解释或引号，使用与用户相同的语言，结尾不加标点。',
        prompt: `用户：${user}\n助手：${assistant}`,
        maxOutputTokens: 48,
        abortSignal: AbortSignal.timeout(15_000),
      });
      return cleanTitle(text);
    } catch {
      return '';
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) {
      await live.mcpHub.close();
      this.live.delete(sessionId);
    }
    this.registry.deleteSession(sessionId);
  }

  async switchSession(sessionId: string): Promise<void> {
    this.registry.setActiveSession(sessionId);
  }

  // -- session driving --

  async startSession(input: StartSessionInput): Promise<{ sessionId: string; runId: string }> {
    const session = this.registry.createSession({
      name: input.name,
      workingDir: input.workingDir,
      config: input.config,
    });
    const live = await this.openSession(session.id);
    const { runId } = live.session.send(input.goal);
    return { sessionId: session.id, runId };
  }

  async sendMessage(sessionId: string, text: string): Promise<{ runId: string }> {
    const live = await this.openSession(sessionId);
    const { runId } = live.session.send(text);
    return { runId };
  }

  approveTool(toolCallId: string, decision: ApprovalDecision): void {
    for (const live of this.live.values()) {
      if (live.session.approveTool(toolCallId, decision)) return;
    }
  }

  setExecutionMode(sessionId: string, mode: ExecutionMode): void {
    const live = this.live.get(sessionId);
    if (live) {
      live.session.setExecutionMode(mode);
      return;
    }
    // Not open yet — open it and apply, so a toggle before the first message
    // still takes hold (fire-and-forget; the contract treats this as best-effort).
    void this.openSession(sessionId)
      .then((l) => l.session.setExecutionMode(mode))
      .catch(() => {});
  }

  async getExecutionMode(sessionId: string): Promise<ExecutionMode> {
    const live = this.live.get(sessionId);
    if (live) return live.session.getExecutionMode();
    // Not open: the configured default is what would apply on open (agent §3.8.1).
    const s = this.registry.getSession(sessionId);
    return this.config.effective(s?.config, this.config.loadSessionAliases(sessionId)).executionMode;
  }

  answerQuestion(questionId: string, answers: UserQuestionAnswer[] | null): void {
    for (const live of this.live.values()) {
      if (live.session.answerQuestion(questionId, answers)) return;
    }
  }

  approvePlan(
    planId: string,
    decision: PlanDecision,
    opts?: { editedPlan?: string; targetMode?: ExecutionMode },
  ): void {
    for (const live of this.live.values()) {
      if (live.session.approvePlan(planId, decision, opts)) return;
    }
  }

  abortRun(runId: string): void {
    for (const live of this.live.values()) {
      if (live.session.abort(runId)) return; // only the owning session is affected
    }
  }

  // -- session tree ops --

  async forkFrom(sessionId: string, entryId: string): Promise<void> {
    (await this.openSession(sessionId)).session.fork(entryId);
  }

  async labelEntry(sessionId: string, entryId: string, label: string): Promise<void> {
    (await this.openSession(sessionId)).session.label(entryId, label);
  }

  async compact(sessionId: string): Promise<void> {
    await (await this.openSession(sessionId)).session.compactManual();
  }

  async getSessionTree(sessionId: string): Promise<SessionTree> {
    const tree = (await this.openSession(sessionId)).store.getTree();
    return { ...tree, root: buildTreeNode(tree.rootId, tree.nodes) };
  }

  async cloneToSession(sessionId: string, leafId: string): Promise<{ sessionId: string }> {
    // Extract the leaf→root path into a new Session (agent §5.4 clone). The
    // clone inherits the source session's working directory.
    const live = await this.openSession(sessionId);
    const src = this.registry.getSession(sessionId);
    const path = live.store.getPath(leafId);
    const clone = this.registry.createSession({
      name: `${src?.name ?? 'Session'} (clone)`,
      workingDir: src?.workingDir,
      config: src?.config,
    });
    const newStore = new SessionStore(this.paths.sessionSession(clone.id));
    for (const e of path) {
      newStore.appendEntry({ agentId: e.agentId, kind: e.kind, content: e.content, summary: e.summary });
    }
    return { sessionId: clone.id };
  }

  async getTodos(sessionId: string): Promise<Todo[]> {
    return (await this.openSession(sessionId)).session.getTodos();
  }

  async report(sessionId: string, prompt: string): Promise<unknown> {
    return (await this.openSession(sessionId)).session.report(prompt);
  }

  // -- model discovery (agent §2.6) --

  async listProviderModels(
    providerId: string,
    opts?: { refresh?: boolean },
  ): Promise<ProviderModelsResult> {
    const provider = this.config.loadProviders().find((p) => p.id === providerId);
    if (!provider) throw new Error(`provider ${providerId} not found`);
    // Refresh the models.dev catalog so discovered models get real meta (and the
    // `hasMeta` flag) — bypass the TTL when the caller forces a provider refresh.
    void this.modelsDev.refresh(opts?.refresh ?? false);
    return this.catalog.list(provider, opts?.refresh ?? false);
  }

  async dispose(): Promise<void> {
    for (const live of this.live.values()) await live.mcpHub.close();
    this.live.clear();
    this.listeners.clear();
  }

  // -- session construction --

  /**
   * Resolve the landstrip executable to wrap commands with (agent §4.1): prefer
   * the agent's managed pinned build (downloaded + cached on first use), else a
   * `landstrip` already on PATH. Memoized for the host's lifetime; undefined →
   * caller falls back to no-sandbox.
   */
  private resolveSandboxBin(): Promise<string | undefined> {
    return (this.landstripBin ??= (async () => {
      const managed = await resolveLandstripBinary(this.paths.cache);
      if (managed) return managed;
      return LandstripSandbox.isAvailable() ? 'landstrip' : undefined;
    })());
  }

  private async openSession(sessionId: string): Promise<LiveSession> {
    const existing = this.live.get(sessionId);
    if (existing) return existing;
    // Kick off a models.dev refresh so the run's accounting + context gauge use
    // accurate metadata (agent §2.6); fire-and-forget, the cache serves meanwhile.
    void this.modelsDev.refresh();
    const built = await this.buildSession(sessionId);
    this.live.set(sessionId, built);
    return built;
  }

  /** Resolve a session's file boundary: workingDir, else default working dir. */
  private rootPathFor(s: Session): string {
    return s.workingDir ?? this.config.loadSettings().defaultWorkingDir ?? this.paths.sessionScratch(s.id);
  }

  private async buildSession(sessionId: string): Promise<LiveSession> {
    const s = this.registry.getSession(sessionId);
    if (!s) throw new Error(`session ${sessionId} not found`);

    const scopeAliases = this.config.loadSessionAliases(sessionId);
    const eff = this.config.effective(s.config, scopeAliases);
    const skillRoots = [this.paths.skills, this.paths.sessionSkills(sessionId)];
    const mcpPaths = this.config.mcpConfigPaths(sessionId);

    return this.assemble({
      sessionId,
      rootPaths: [this.rootPathFor(s)],
      eff,
      skillRoots,
      mcpPaths,
      goal: s.name,
      seedUsage: s.usage,
      seedTodos: s.todos,
      persistTodos: (todos) => this.registry.saveSession({ ...this.registry.getSession(sessionId)!, todos }),
      persistUsage: (usage, lastInputTokens) => {
        const cur = this.registry.getSession(sessionId);
        if (cur) this.registry.saveSession({ ...cur, usage, lastInputTokens });
      },
    });
  }

  private async assemble(p: AssembleParams): Promise<LiveSession> {
    const providers = this.config.loadProviders();
    const modelRegistry = new ModelRegistry(providers, p.eff.aliases, this.keychain);

    // Use the OS sandbox when enabled and a landstrip binary is resolvable: the
    // agent manages its own pinned build (downloaded + cached on first use,
    // §4.1), falling back to one on PATH. If neither is available, drop to
    // no-sandbox (commands still gated by approval + path checks) and warn once,
    // so execution works instead of failing every command with ENOENT.
    const bin = p.eff.sandboxEnabled ? await this.resolveSandboxBin() : undefined;
    const sandbox: Sandbox = bin ? new LandstripSandbox({ bin }) : new NoopSandbox();
    if (p.eff.sandboxEnabled && !bin && !this.sandboxWarned) {
      this.sandboxWarned = true;
      this.emit({
        kind: 'error',
        runId: 'sandbox',
        message:
          '无法获取沙箱执行器 landstrip（下载失败或平台不支持）——已切换为无沙箱执行：命令直接在本机运行，不受 landstrip 隔离边界保护（仍受审批与路径检查约束）。联网后重启可自动下载，或在 /config 关闭沙箱以消除此提示。',
      });
    }
    const sandboxPolicy = sandbox.buildPolicy({
      rootPaths: p.rootPaths,
      allowHosts: p.eff.permission.allowHosts,
      allowNetwork: p.eff.sandboxNetwork,
    });

    const store = new SessionStore(this.paths.sessionSession(p.sessionId));
    const runs = new RunStore(this.paths.sessionRuns(p.sessionId));
    const audit = new AuditStore(this.paths.sessionAudit(p.sessionId));
    const accountant = new Accountant(this.meta, p.seedUsage);
    const grants = new GrantTable();
    const skills = new SkillRegistry(p.skillRoots);
    const concurrency = new Semaphore(p.eff.maxConcurrency);

    const mcpHub = new McpHub(this.keychain);
    await mcpHub.connect(McpHub.loadConfigs(p.mcpPaths), (server, message) =>
      this.emit({ kind: 'error', runId: 'mcp', message: `MCP '${server}': ${message}` }),
    );

    let todos: Todo[] = [...p.seedTodos];

    const orchestratorAlias = p.eff.orchestratorAlias;
    const orchestratorModelRef = modelRegistry.refForAlias(orchestratorAlias) ?? FALLBACK_ORCH_REF;

    // Capability validation at assembly time, not run time (agent §2.6 pt.2):
    // the orchestrator and any tool-using role alias must support `tools`.
    modelRegistry.assertCapability(orchestratorAlias, 'tools');
    for (const alias of Object.values(p.eff.roleAliases)) {
      modelRegistry.assertCapability(alias, 'tools');
    }

    // A role's alias: explicit per-role config, else the orchestrator's alias —
    // NOT the literal role name. An unconfigured role (e.g. 'writer' with no
    // roleAliases entry) must run on the same working model as the orchestrator,
    // not silently fall through to a hardcoded built-in ref that may not be
    // configured/reachable in this setup — that made every sub-agent produce 0
    // steps while the orchestrator worked (agent §2.6).
    const aliasFor = (role: string): string =>
      role === 'orchestrator' ? orchestratorAlias : p.eff.roleAliases[role] ?? orchestratorAlias;

    const resolveRef = (role: string): string => {
      const alias = aliasFor(role);
      // Fall back to the built-in ref so cost accounting matches the model that
      // resolve() will actually use (agent §2.6 precedence tail).
      return modelRegistry.refForAlias(alias) ?? (alias.includes(':') ? alias : FALLBACK_ORCH_REF);
    };

    const emitter: ApprovalEmitter = {
      emitApprovalRequired: (req: GateRequest) =>
        this.emit({
          kind: 'tool-approval-required',
          runId: req.runId,
          agentId: req.agentId,
          parentAgentId: req.parentAgentId,
          toolCallId: req.toolCallId,
          toolName: req.toolName,
          input: req.input,
          grantScope: req.grantScope,
        }),
    };
    const approval = new ApprovalController(grants, emitter);

    const questionEmitter: QuestionEmitter = {
      emitQuestionRequired: (req: QuestionRequest) =>
        this.emit({
          kind: 'user-question-required',
          runId: req.runId,
          agentId: req.agentId,
          parentAgentId: req.parentAgentId,
          questionId: req.questionId,
          questions: req.questions,
        }),
    };
    const questions = new QuestionController(questionEmitter);

    const planEmitter: PlanEmitter = {
      emitPlanProposed: (req: PlanProposal) =>
        this.emit({
          kind: 'plan-proposed',
          runId: req.runId,
          agentId: req.agentId,
          parentAgentId: req.parentAgentId,
          planId: req.planId,
          plan: req.plan,
          allowedActions: req.allowedActions,
        }),
    };
    const plan = new PlanController(planEmitter);

    // Live-mutable execution mode (agent §3.8): one ref shared by the
    // orchestrator and all sub-agents, so setExecutionMode is seen everywhere.
    const executionMode = { value: p.eff.executionMode };

    // Auto-mode classifier (agent §3.8.5): runs on a configured 'classifier' alias
    // when one exists, else the orchestrator's own model. Resolved lazily per call.
    const classifierAlias = modelRegistry.aliasNames.has(p.eff.classifierAlias)
      ? p.eff.classifierAlias
      : orchestratorAlias;
    const autoClassifier = new AutoClassifier(() => modelRegistry.resolve(classifierAlias), store, {
      stages: p.eff.classifierStages,
      rules: p.eff.classifierRules,
    });
    const auto = {
      enabled: p.eff.autoEnabled,
      classify: (call: Parameters<AutoClassifier['classify']>[0], signal?: AbortSignal) =>
        autoClassifier.classify(call, signal),
    };

    const services: SessionServices = {
      sessionId: p.sessionId,
      approval,
      questions,
      plan,
      audit,
      runs,
      session: store,
      accountant,
      sandbox,
      sandboxPolicy,
      meta: this.meta,
      keychain: this.keychain,
      permission: p.eff.permission,
      executionMode,
      planAllowNetwork: p.eff.planAllowNetwork,
      auto,
      rootPaths: p.rootPaths,
      maxDepth: p.eff.maxDepth,
      maxConcurrency: p.eff.maxConcurrency,
      subAgentTimeoutMs: (role) => timeoutForRole(p.eff, role),
      delegateRoles: new Set(p.eff.delegateRoles),
      concurrency,
      emit: (e) => this.emit(e),
      setTodos: (next) => {
        todos = next;
        p.persistTodos(next);
      },
      getTodos: () => todos,
      persistUsage: (usage, lastInputTokens) => p.persistUsage(usage, lastInputTokens),
      modelFor: (role) => modelRegistry.resolve(aliasFor(role)),
      modelRefFor: resolveRef,
      nextSubId: (() => {
        let n = 0;
        return () => ++n;
      })(),
      wrapMcpTools: (ctx, allow) => mcpHub.wrapAll(ctx, allow),
      subAgentSkillCatalog: (toolNames, query) => skills.catalog(toolNames, query),
      loadSkill: (name, allowedToolNames) => skills.loadForModel(name, allowedToolNames),
      searchSkills: (query, allowedToolNames) =>
        skills.search(query, { allowedToolNames, limit: 12 }).map((h) => ({
          name: h.meta.name,
          description: h.meta.description,
        })),
    };

    const session = new RuntimeSession(services, store, {
      goal: p.goal,
      buildSkillCatalog: (query) => skills.catalog(undefined, query),
      maxSteps: p.eff.maxSteps,
      compactRatio: p.eff.compactRatio,
      orchestratorModelRef,
    });

    return { session, services, store, mcpHub };
  }
}

interface AssembleParams {
  sessionId: string;
  rootPaths: string[];
  eff: ReturnType<ConfigStore['effective']>;
  skillRoots: string[];
  mcpPaths: string[];
  goal: string;
  seedUsage: Session['usage'];
  seedTodos: Todo[];
  persistTodos: (todos: Todo[]) => void;
  persistUsage: (usage: Session['usage'], lastInputTokens: number) => void;
}

/** Normalize a model-produced title: first line, no quotes/punctuation, capped. */
function cleanTitle(raw: string): string {
  let t = (raw.split('\n').find((l) => l.trim()) ?? '').trim();
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  t = t.replace(/[。.!！?？:：,，;；]+$/g, '').trim();
  // Cap to a reasonable header length (CJK-aware would be nicer; chars suffice).
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

function buildTreeNode(
  id: string | undefined,
  nodes: Record<string, import('@enterprise-agent/agent-contract').Entry>,
): SessionTree['root'] {
  if (!id || !nodes[id]) return undefined;
  const childIds = Object.values(nodes)
    .filter((e) => e.parentId === id)
    .map((e) => e.id);
  return {
    entry: nodes[id]!,
    children: childIds.map((c) => buildTreeNode(c, nodes)!).filter(Boolean),
  };
}

/** Construct the agent host (agent §6 contract entry point). */
export function createAgentHost(opts?: AgentHostOptions): AgentHost {
  return new EnterpriseAgentHost(opts);
}

export { generateReport, ReportSchema, type Report } from './runtime/report.js';
export type { Sandbox, SandboxPolicy } from './sandbox/sandbox.js';
export { LandstripSandbox } from './sandbox/landstrip.js';
export { NoopSandbox } from './sandbox/noop.js';
export { resolveLandstripBinary, landstripAsset, LANDSTRIP_VERSION } from './sandbox/install.js';
export type { KeyStore } from './config/keychain.js';
export { EnvKeyStore } from './config/keychain.js';

// -- Host utilities: config/skill management against the same files the agent
//    reads (agent §5.2). Hosts (CLI) use these to expose "configure everything".
export { createPaths, type Paths } from './config/paths.js';
export { ConfigStore, DEFAULT_SETTINGS, SUB_AGENT_ROLES, timeoutForRole, type EffectiveConfig } from './config/store.js';
export { ModelMetaRegistry, BUILTIN_MODEL_META } from './models/meta.js';
export { ModelCatalog, type ModelCatalogOptions } from './models/catalog.js';
export { ModelsDevStore, buildModelsDevIndex, MODELS_DEV_URL, type ModelsDevIndex, type ModelsDevStoreOptions } from './models/models-dev.js';
export {
  BUILTIN_PROVIDERS,
  findProviderPreset,
  type ProviderPreset,
  type ProviderRegion,
} from './models/providers.js';
export {
  SkillRegistry,
  DEFAULT_SKILL_SEARCH_THRESHOLD,
  type SkillMeta,
  type SkillHit,
  type SkillSearchOptions,
} from './skills/loader.js';

export * from '@enterprise-agent/agent-contract';
