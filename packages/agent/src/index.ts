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
  MemoryPort,
  MemoryScope,
  ModelCapability,
  PlanDecision,
  ProviderModelsResult,
  ScopedConfig,
  Session,
  SessionTree,
  StartSessionInput,
  Todo,
  UserPart,
  UserQuestionAnswer,
} from '@enterprise-agent/agent-contract';

import { generateText } from 'ai';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createPaths, type Paths } from './config/paths.js';
import { ConfigStore, resolveMemoryScope, timeoutForRole } from './config/store.js';
import { EnvKeyStore, type KeyStore } from './config/keychain.js';
import { RegistryStore } from './storage/registry-store.js';
import { SessionStore } from './storage/session-store.js';
import { RunStore } from './storage/run-store.js';
import { AuditStore } from './storage/audit-store.js';
import { ScheduleStore, type ScheduleState } from './storage/schedule-store.js';
import { ScheduleRegistry, type ScheduleDef } from './schedules/registry.js';
import { Scheduler } from './schedules/scheduler.js';
import { parseScheduleGrants } from './schedules/grants.js';
import { ORCHESTRATOR_AGENT_ID } from '@enterprise-agent/agent-contract';
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
import { AgentRegistry, buildSeedAgents } from './agents/registry.js';
import { McpHub } from './mcp/client.js';
import { LandstripSandbox } from './sandbox/landstrip.js';
import { NoopSandbox } from './sandbox/noop.js';
import { resolveLandstripBinary } from './sandbox/install.js';
import type { Sandbox } from './sandbox/sandbox.js';
import { Session as RuntimeSession } from './runtime/session.js';
import type { SessionServices } from './runtime/context.js';
import { entryText } from './util/entry-text.js';

export interface AgentHostOptions {
  /** App data root; defaults to ENTERPRISE_AGENT_HOME or ~/.enterprise-agent. */
  root?: string;
  /** Secret backend; defaults to env-backed store (agent §4). */
  keychain?: KeyStore;
  /**
   * Cross-session memory backend (memory §1/§5). Optional: only takes effect
   * when `settings.memory.enabled` is true. The same port serves every session;
   * per-session isolation is by `MemoryScope` (memory §4). Omitted → memory is
   * off regardless of settings, and the turn-loop hooks no-op.
   */
  memory?: MemoryPort;
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
  private readonly scheduleStore: ScheduleStore;
  private readonly scheduler: Scheduler;
  private readonly meta = new ModelMetaRegistry();
  private readonly keychain: KeyStore;
  private readonly memory?: MemoryPort;
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
    this.scheduleStore = new ScheduleStore(this.paths.schedulesState);
    this.scheduler = new Scheduler({
      now: () => Date.now(),
      list: () => this.scheduleRegistry().list(),
      getState: (name) => this.scheduleStore.get(name),
      putState: (state) => this.scheduleStore.put(state),
      fire: (name) => this.runScheduleNow(name).then(() => {}),
    });
    this.keychain = opts.keychain ?? new EnvKeyStore();
    this.memory = opts.memory;
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
      return e ? entryText(e).trim() : '';
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
    const { runId } = live.session.send(input.goal, input.parts);
    return { sessionId: session.id, runId };
  }

  async sendMessage(sessionId: string, text: string, parts?: UserPart[]): Promise<{ runId: string }> {
    const live = await this.openSession(sessionId);
    const { runId } = live.session.send(text, parts);
    return { runId };
  }

  // -- schedules (§7 定时编排) --

  /** Discover schedule definitions fresh (picks up newly-added SCHEDULE.md) and
   *  merge each with its durable run state (last/next run). */
  async listSchedules(): Promise<Array<ScheduleDef & { state?: ScheduleState }>> {
    const states = new Map(this.scheduleStore.all().map((s) => [s.name, s]));
    return this.scheduleRegistry()
      .list()
      .map((d) => ({ ...d, state: states.get(d.name) }));
  }

  /**
   * Fire a schedule now (manual trigger; the cron tick is B-P2). Resolves the
   * session (fresh or a pinned reuse), forces the schedule's execution mode
   * (unattended → `auto`, §7 B.2), sends the goal, awaits completion, and records
   * the run state. Delivery of the result (`deliver-to`) and grant pre-authorization
   * are B-P3; here the orchestrator simply runs the goal.
   */
  async runScheduleNow(name: string): Promise<{ sessionId: string; runId: string; status: 'done' | 'error' }> {
    const def = this.scheduleRegistry().get(name);
    if (!def) throw new Error(`schedule ${name} not found`);
    let sessionId: string;
    if (def.session.kind === 'reuse') {
      if (!this.registry.getSession(def.session.id)) {
        throw new Error(`schedule ${name}: reuse session ${def.session.id} not found`);
      }
      sessionId = def.session.id;
    } else {
      sessionId = this.registry.createSession({ name: `schedule:${def.name}` }).id;
    }
    const live = await this.openSession(sessionId);
    live.session.setExecutionMode(def.mode);
    // Unattended (§7 B.2): no human to approve → the gate fails closed (ask→deny).
    live.services.unattended.value = true;
    // Pre-authorize the schedule's declared grants (§7 B.3): those exact scopes are
    // honored by the gate; everything else high-risk still denies. Session-shared so
    // the run's sub-agents inherit them.
    for (const g of parseScheduleGrants(def.grants ?? [], ORCHESTRATOR_AGENT_ID)) {
      live.services.approval.grant(g);
    }
    const { runId, completion } = live.session.send(def.goal);
    this.emit({ kind: 'schedule-fired', name: def.name, sessionId, runId });
    let status: 'done' | 'error' = 'done';
    try {
      await completion;
    } catch {
      status = 'error';
    } finally {
      live.services.unattended.value = false;
    }
    this.scheduleStore.put({ name: def.name, lastRunAt: Date.now(), lastRunId: runId, lastStatus: status });
    // Surface the final assistant text so a host can deliver it (§7 B.6).
    const summary = lastAssistantText(live.store.getPath());
    this.emit({ kind: 'schedule-finished', name: def.name, sessionId, runId, status, summary, deliverTo: def.deliverTo });
    return { sessionId, runId, status };
  }

  /** Start the schedule timer (default every 60s). A long-running host (the
   *  gateway) calls this at boot; the CLI may call it while interactive. Idempotent. */
  startScheduler(intervalMs?: number): void {
    this.scheduler.start(intervalMs);
  }

  /** Stop the schedule timer (idempotent). */
  stopScheduler(): void {
    this.scheduler.stop();
  }

  /** Run one scheduler evaluation immediately (for tests / manual ticks). */
  async tickSchedules(): Promise<void> {
    await this.scheduler.tick();
  }

  /** A fresh registry over the global schedules dir (cheap; reflects edits). */
  private scheduleRegistry(): ScheduleRegistry {
    return new ScheduleRegistry([this.paths.schedules]);
  }

  /** Capabilities of a model (multimodal §3.1); with no `ref`, the orchestrator
   *  resolved under `scope`'s model/alias overrides (so a per-channel model gates
   *  media correctly). Unions the metadata catalog (built-ins + models.dev) with
   *  any `capabilities` declared on the model alias — the latter is the escape
   *  hatch for a multimodal model the catalog doesn't cover yet (a self-hosted or
   *  newly-released vision model), and is the same field `assertCapability`
   *  already treats as authoritative. Empty when both are unknown. */
  async modelCapabilities(ref?: string, scope?: ScopedConfig): Promise<ModelCapability[]> {
    if (ref) return this.meta.get(ref).capabilities ?? [];
    const { ref: resolved, aliasCaps } = this.orchestratorModel(scope);
    const metaCaps = resolved ? this.meta.get(resolved).capabilities ?? [] : [];
    return aliasCaps?.length ? [...new Set([...metaCaps, ...aliasCaps])] : metaCaps;
  }

  /** Resolve the effective `orchestrator` alias to its concrete `provider:model`
   *  ref plus any `capabilities` declared along the alias chain (first declaration
   *  wins). Honors `scope`'s `model`/`aliases` overrides via the same `effective`
   *  merge the session assembly uses, so capability gating matches the model the
   *  session will actually run — not the global default. */
  private orchestratorModel(scope?: ScopedConfig): { ref?: string; aliasCaps?: ModelCapability[] } {
    const eff = this.config.effective(scope, []);
    let name: string | undefined = eff.orchestratorAlias;
    let aliasCaps: ModelCapability[] | undefined;
    for (let i = 0; name && !name.includes(':') && i < 5; i++) {
      const entry = eff.aliases.find((a) => a.alias === name);
      if (!aliasCaps && entry?.capabilities?.length) aliasCaps = entry.capabilities;
      name = entry?.ref;
    }
    return { ref: name?.includes(':') ? name : undefined, aliasCaps };
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
    this.scheduler.stop();
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
    const agentRoots = [this.paths.agents, this.paths.sessionAgents(sessionId)];
    const mcpPaths = this.config.mcpConfigPaths(sessionId);

    // Resolve the session's memory isolation scope (memory §4): host-supplied
    // key wins, else derive from the scope mode using the project dir name.
    const memoryScope = eff.memoryEnabled
      ? resolveMemoryScope(eff, {
          namespace: s.config?.memoryNamespace,
          projectSlug: s.workingDir ? basename(s.workingDir) : undefined,
        })
      : undefined;

    return this.assemble({
      sessionId,
      rootPaths: [this.rootPathFor(s)],
      eff,
      skillRoots,
      agentRoots,
      mcpPaths,
      memoryScope,
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
    // Skill dirs are part of the execution boundary (read + run, never write,
    // §3.6/§4). Filter to existing roots so a missing session-skills dir isn't
    // handed to the sandbox or the cwd guard.
    const skillRoots = p.skillRoots.filter((d) => existsSync(d));
    const sandboxPolicy = sandbox.buildPolicy({
      rootPaths: p.rootPaths,
      readPaths: skillRoots,
      allowHosts: p.eff.permission.allowHosts,
      allowNetwork: p.eff.sandboxNetwork,
    });

    const store = new SessionStore(this.paths.sessionSession(p.sessionId));
    const runs = new RunStore(this.paths.sessionRuns(p.sessionId));
    const audit = new AuditStore(this.paths.sessionAudit(p.sessionId));
    const accountant = new Accountant(this.meta, p.seedUsage);
    const grants = new GrantTable();
    const skills = new SkillRegistry(p.skillRoots);
    // Declarative sub-agents (§2.3): built-in seeds + discovered AGENT.md, merged
    // global → session (later overrides). No disk dir → just the five seeds, so
    // behaviour is identical to the old fixed enum.
    const agents = new AgentRegistry(buildSeedAgents(), p.agentRoots, p.eff.agents);
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
    // Unattended flag (§7 B.2): off for interactive sessions; the scheduler flips
    // it on for the duration of a scheduled fire so the gate fails closed.
    const unattended = { value: false };

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
      bypass: p.eff.autoBypass,
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
      unattended,
      planAllowNetwork: p.eff.planAllowNetwork,
      auto,
      rootPaths: p.rootPaths,
      skillRoots,
      maxDepth: p.eff.maxDepth,
      maxConcurrency: p.eff.maxConcurrency,
      subAgentTimeoutMs: (role) => timeoutForRole(p.eff, role),
      delegateAgents: new Set(p.eff.delegateAgents),
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
      // An agent definition's explicit `model:` (alias or provider:model ref),
      // resolved directly — resolve()/refForAlias() both accept either form.
      modelForAlias: (alias) => modelRegistry.resolve(alias),
      modelRefForAlias: (alias) =>
        modelRegistry.refForAlias(alias) ?? (alias.includes(':') ? alias : FALLBACK_ORCH_REF),
      agents,
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
      // Memory (memory §1): attach the port only when enabled AND scope resolved
      // (i.e. a port was provided). Disabled/absent → undefined, so the turn-loop
      // hooks (memory §3) all no-op.
      memory: p.memoryScope ? this.memory : undefined,
      memoryScope: p.memoryScope,
      memoryRetrieve: { topK: p.eff.memoryTopK, timeoutMs: p.eff.memoryTimeoutMs },
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
  agentRoots: string[];
  mcpPaths: string[];
  /** Resolved memory scope (memory §4); undefined when memory is disabled. */
  memoryScope?: MemoryScope;
  goal: string;
  seedUsage: Session['usage'];
  seedTodos: Todo[];
  persistTodos: (todos: Todo[]) => void;
  persistUsage: (usage: Session['usage'], lastInputTokens: number) => void;
}

/** The text of the last assistant entry on a path (the schedule run's result). */
function lastAssistantText(path: import('@enterprise-agent/agent-contract').Entry[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    const e = path[i]!;
    if (e.kind === 'assistant') return entryText(e).trim();
  }
  return '';
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
export { ConfigStore, DEFAULT_SETTINGS, SUB_AGENT_ROLES, timeoutForRole, resolveMemoryScope, type EffectiveConfig } from './config/store.js';
export { AgentRegistry, buildSeedAgents, type AgentDef } from './agents/registry.js';
export { ScheduleRegistry, type ScheduleDef, type ScheduleSession } from './schedules/registry.js';
export { ScheduleStore, type ScheduleState } from './storage/schedule-store.js';
export { Scheduler, type SchedulerDeps } from './schedules/scheduler.js';
export { parseScheduleGrants } from './schedules/grants.js';
export { nextRunAfter, nextCronAfter, parseCron, parseEvery } from './schedules/cron.js';
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
