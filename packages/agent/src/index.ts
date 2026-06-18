/**
 * @enterprise-agent/agent — public entry. Implements the agent §6 command/event contract
 * (`AgentHost`). A host (desktop utilityProcess, CLI) constructs one host and
 * drives Works/Chats through it; everything below — runtime, tools, approval,
 * MCP, skills, sandbox, file storage — is internal to this package.
 */
import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  Chat,
  CreateChatInput,
  CreateWorkspaceInput,
  ScopedConfig,
  SessionRef,
  SessionTree,
  StartWorkInput,
  Todo,
  Work,
  Workspace,
} from '@enterprise-agent/agent-contract';

import { createPaths, type Paths } from './config/paths.js';
import { ConfigStore } from './config/store.js';
import { EnvKeyStore, type KeyStore } from './config/keychain.js';
import { RegistryStore } from './storage/registry-store.js';
import { SessionStore } from './storage/session-store.js';
import { RunStore } from './storage/run-store.js';
import { AuditStore } from './storage/audit-store.js';
import { ModelMetaRegistry } from './models/meta.js';
import { ModelRegistry, BUILTIN_FALLBACK_REF } from './models/registry.js';
import { Accountant } from './runtime/accountant.js';
import { GrantTable } from './approval/grants.js';
import { ApprovalController, type ApprovalEmitter, type GateRequest } from './approval/approval.js';
import { Semaphore } from './util/semaphore.js';
import { SkillRegistry } from './skills/loader.js';
import { McpHub } from './mcp/client.js';
import { LandstripSandbox } from './sandbox/landstrip.js';
import { NoopSandbox } from './sandbox/noop.js';
import type { Sandbox } from './sandbox/sandbox.js';
import { Session } from './runtime/session.js';
import type { SessionServices } from './runtime/context.js';

export interface AgentHostOptions {
  /** App data root; defaults to ENTERPRISE_AGENT_HOME or ~/.enterprise-agent. */
  root?: string;
  /** Secret backend; defaults to env-backed store (agent §4). */
  keychain?: KeyStore;
}

interface LiveSession {
  session: Session;
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
  private readonly listeners = new Set<(e: AgentStreamEvent) => void>();
  private readonly sessions = new Map<string, LiveSession>();

  constructor(opts: AgentHostOptions = {}) {
    this.paths = createPaths(opts.root);
    this.config = new ConfigStore(this.paths);
    this.registry = new RegistryStore(this.paths);
    this.keychain = opts.keychain ?? new EnvKeyStore();
  }

  // -- events --

  onEvent(listener: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: AgentStreamEvent): void {
    for (const l of this.listeners) l(event);
  }

  // -- workspaces --

  async listWorkspaces(): Promise<Workspace[]> {
    return this.registry.listWorkspaces();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    return this.registry.createWorkspace(input);
  }

  async switchWorkspace(workspaceId: string): Promise<void> {
    this.registry.setActiveWorkspace(workspaceId);
  }

  async updateWorkspaceConfig(workspaceId: string, config: ScopedConfig): Promise<Workspace> {
    const ws = this.registry.getWorkspace(workspaceId);
    if (!ws) throw new Error(`workspace ${workspaceId} not found`);
    const updated = { ...ws, config };
    this.registry.saveWorkspace(updated);
    return updated;
  }

  // -- chats --

  async listChats(): Promise<Chat[]> {
    return this.registry.listChats();
  }

  async createChat(input: CreateChatInput): Promise<Chat> {
    return this.registry.createChat(input);
  }

  async updateChatConfig(chatId: string, config: ScopedConfig): Promise<Chat> {
    const chat = this.registry.getChat(chatId);
    if (!chat) throw new Error(`chat ${chatId} not found`);
    const updated = { ...chat, config };
    this.registry.saveChat(updated);
    return updated;
  }

  // -- works --

  async listWorks(workspaceId: string): Promise<Work[]> {
    return this.registry.listWorks(workspaceId);
  }

  async createWork(input: { workspaceId: string; title: string; goal: string }): Promise<Work> {
    return this.registry.createWork(input);
  }

  // -- session driving --

  async startWork(input: StartWorkInput): Promise<{ workId: string; runId: string }> {
    const work = this.registry.createWork({
      workspaceId: input.workspaceId,
      title: input.title,
      goal: input.goal,
    });
    const live = await this.openSession({ kind: 'work', id: work.id });
    const { runId } = live.session.send(input.goal);
    return { workId: work.id, runId };
  }

  async sendMessage(session: SessionRef, text: string): Promise<{ runId: string }> {
    const live = await this.openSession(session);
    const { runId } = live.session.send(text);
    return { runId };
  }

  approveTool(toolCallId: string, decision: ApprovalDecision): void {
    for (const live of this.sessions.values()) {
      if (live.session.approveTool(toolCallId, decision)) return;
    }
  }

  abortRun(runId: string): void {
    for (const live of this.sessions.values()) {
      if (live.session.abort(runId)) return; // only the owning session is affected
    }
  }

  // -- session tree ops --

  async forkFrom(session: SessionRef, entryId: string): Promise<void> {
    (await this.openSession(session)).session.fork(entryId);
  }

  async labelEntry(session: SessionRef, entryId: string, label: string): Promise<void> {
    (await this.openSession(session)).session.label(entryId, label);
  }

  async compact(session: SessionRef): Promise<void> {
    await (await this.openSession(session)).session.compactManual();
  }

  async getSessionTree(session: SessionRef): Promise<SessionTree> {
    const tree = (await this.openSession(session)).store.getTree();
    return { ...tree, root: buildTreeNode(tree.rootId, tree.nodes) };
  }

  async cloneToWork(session: SessionRef, leafId: string): Promise<{ workId: string }> {
    // Extract the leaf→root path into a new Work (agent §5.4 clone).
    const live = await this.openSession(session);
    const path = live.store.getPath(leafId);
    const wsId = session.kind === 'work' ? this.workspaceOf(session.id) : this.defaultWorkspaceId();
    const work = this.registry.createWork({
      workspaceId: wsId,
      title: 'Clone',
      goal: textOfFirst(path),
    });
    const newStore = new SessionStore(this.paths.workSession(wsId, work.id));
    for (const e of path) {
      newStore.appendEntry({ agentId: e.agentId, kind: e.kind, content: e.content, summary: e.summary });
    }
    return { workId: work.id };
  }

  async getTodos(session: SessionRef): Promise<Todo[]> {
    return (await this.openSession(session)).session.getTodos();
  }

  async report(session: SessionRef, prompt: string): Promise<unknown> {
    return (await this.openSession(session)).session.report(prompt);
  }

  async dispose(): Promise<void> {
    for (const live of this.sessions.values()) await live.mcpHub.close();
    this.sessions.clear();
    this.listeners.clear();
  }

  // -- session construction --

  private async openSession(ref: SessionRef): Promise<LiveSession> {
    const existing = this.sessions.get(ref.id);
    if (existing) return existing;

    const live =
      ref.kind === 'work'
        ? await this.buildWorkSession(ref.id)
        : await this.buildChatSession(ref.id);
    this.sessions.set(ref.id, live);
    return live;
  }

  private async buildWorkSession(workId: string): Promise<LiveSession> {
    const workspaceId = this.workspaceOf(workId);
    const ws = this.registry.getWorkspace(workspaceId);
    const work = this.registry.getWork(workspaceId, workId);
    if (!ws || !work) throw new Error(`work ${workId} not found`);

    const scopeAliases = this.config.loadWorkspaceAliases(workspaceId);
    const eff = this.config.effective(ws.config, scopeAliases);
    const skillRoots = [this.paths.skills, this.paths.workspaceSkills(workspaceId)];
    const mcpPaths = this.config.mcpConfigPaths(workspaceId);

    return this.assemble({
      sessionId: workId,
      workId,
      rootPaths: [ws.rootPath],
      eff,
      skillRoots,
      mcpPaths,
      goal: work.goal,
      sessionFile: this.paths.workSession(workspaceId, workId),
      runsFile: this.paths.workRuns(workspaceId, workId),
      auditFile: this.paths.workAudit(workspaceId, workId),
      seedUsage: work.usage,
      seedTodos: work.todos,
      persistTodos: (todos) => this.registry.saveWork({ ...this.registry.getWork(workspaceId, workId)!, todos }),
    });
  }

  private async buildChatSession(chatId: string): Promise<LiveSession> {
    const chat = this.registry.getChat(chatId);
    if (!chat) throw new Error(`chat ${chatId} not found`);
    const eff = this.config.effective(chat.config, []);
    const skillRoots = [this.paths.skills];
    const mcpPaths = this.config.mcpConfigPaths();

    return this.assemble({
      sessionId: chatId,
      workId: chatId,
      rootPaths: [this.paths.chatScratch(chatId)],
      eff,
      skillRoots,
      mcpPaths,
      goal: chat.name,
      sessionFile: this.paths.chatSession(chatId),
      runsFile: this.paths.chatRuns(chatId),
      auditFile: this.paths.chatAudit(chatId),
      seedUsage: chat.usage,
      seedTodos: chat.todos,
      persistTodos: (todos) => this.registry.saveChat({ ...this.registry.getChat(chatId)!, todos }),
    });
  }

  private async assemble(p: AssembleParams): Promise<LiveSession> {
    const providers = this.config.loadProviders();
    const modelRegistry = new ModelRegistry(providers, p.eff.aliases, this.keychain);

    const sandbox: Sandbox = p.eff.sandboxEnabled ? new LandstripSandbox() : new NoopSandbox();
    const sandboxPolicy = sandbox.buildPolicy({
      rootPaths: p.rootPaths,
      allowHosts: p.eff.permission.allowHosts,
    });

    const store = new SessionStore(p.sessionFile);
    const runs = new RunStore(p.runsFile);
    const audit = new AuditStore(p.auditFile);
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

    const resolveRef = (role: string): string => {
      const alias = role === 'orchestrator' ? orchestratorAlias : p.eff.roleAliases[role] ?? role;
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

    const services: SessionServices = {
      sessionId: p.sessionId,
      workId: p.workId,
      approval,
      audit,
      runs,
      session: store,
      accountant,
      sandbox,
      sandboxPolicy,
      meta: this.meta,
      keychain: this.keychain,
      permission: p.eff.permission,
      rootPaths: p.rootPaths,
      maxDepth: p.eff.maxDepth,
      maxConcurrency: p.eff.maxConcurrency,
      concurrency,
      emit: (e) => this.emit(e),
      setTodos: (next) => {
        todos = next;
        p.persistTodos(next);
      },
      getTodos: () => todos,
      modelFor: (role) => modelRegistry.resolve(role === 'orchestrator' ? orchestratorAlias : p.eff.roleAliases[role] ?? role),
      modelRefFor: resolveRef,
      nextSubId: (() => {
        let n = 0;
        return () => ++n;
      })(),
      wrapMcpTools: (ctx, allow) => mcpHub.wrapAll(ctx, allow),
    };

    const session = new Session(services, store, {
      goal: p.goal,
      skillCatalog: skills.catalog(),
      maxSteps: p.eff.maxSteps,
      compactRatio: p.eff.compactRatio,
      orchestratorModelRef,
    });

    return { session, services, store, mcpHub };
  }

  // -- helpers --

  private workspaceOf(workId: string): string {
    for (const ws of this.registry.listWorkspaces()) {
      if (this.registry.getWork(ws.id, workId)) return ws.id;
    }
    throw new Error(`no workspace owns work ${workId}`);
  }

  private defaultWorkspaceId(): string {
    const list = this.registry.listWorkspaces();
    const active = list.find((w) => w.isActive) ?? list[0];
    if (!active) throw new Error('no workspace exists');
    return active.id;
  }
}

interface AssembleParams {
  sessionId: string;
  workId: string;
  rootPaths: string[];
  eff: ReturnType<ConfigStore['effective']>;
  skillRoots: string[];
  mcpPaths: string[];
  goal: string;
  sessionFile: string;
  runsFile: string;
  auditFile: string;
  seedUsage: Work['usage'];
  seedTodos: Todo[];
  persistTodos: (todos: Todo[]) => void;
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

function textOfFirst(path: import('@enterprise-agent/agent-contract').Entry[]): string {
  const first = path.find((e) => e.kind === 'user');
  return (
    first?.content?.map((c) => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('') ??
    'Cloned session'
  );
}

/** Construct the agent host (agent §6 contract entry point). */
export function createAgentHost(opts?: AgentHostOptions): AgentHost {
  return new EnterpriseAgentHost(opts);
}

export { generateReport, ReportSchema, type Report } from './runtime/report.js';
export type { Sandbox, SandboxPolicy } from './sandbox/sandbox.js';
export { LandstripSandbox } from './sandbox/landstrip.js';
export { NoopSandbox } from './sandbox/noop.js';
export type { KeyStore } from './config/keychain.js';
export { EnvKeyStore } from './config/keychain.js';

// -- Host utilities: config/skill management against the same files the agent
//    reads (agent §5.2). Hosts (CLI) use these to expose "configure everything".
export { createPaths, type Paths } from './config/paths.js';
export { ConfigStore, DEFAULT_SETTINGS, type EffectiveConfig } from './config/store.js';
export { ModelMetaRegistry, BUILTIN_MODEL_META } from './models/meta.js';
export { SkillRegistry, type SkillMeta } from './skills/loader.js';

export * from '@enterprise-agent/agent-contract';
