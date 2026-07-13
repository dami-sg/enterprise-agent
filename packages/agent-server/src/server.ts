import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  ExecutionMode,
  PlanDecision,
  ScopedConfig,
  Session,
  UserPart,
  UserQuestionAnswer,
} from '@dami-sg/agent-contract';
import { APPROVAL, EXECUTION_MODE, PROTOCOL_VERSION } from '@dami-sg/agent-contract';
import {
  APP_SERVER_ERROR,
  APP_SERVER_PROTOCOL_VERSION,
  RpcError,
  asRecord,
  asString,
  failure,
  notification,
  parseRequest,
  success,
  type InitializeParams,
  type JsonRpcId,
  type ServerMessage,
  type SubscriptionScope,
  type TurnInputPart,
} from './protocol.js';

export interface AppServerAuth {
  accountId?: string;
  /** Trusted local clients can access sessions without account ownership checks. */
  trusted?: boolean;
}

export interface AppServerConnectionOptions {
  auth: AppServerAuth;
  send(message: ServerMessage): void | Promise<void>;
  close?: () => void;
}

export interface AppServerAccessPolicy {
  ownsSession(auth: AppServerAuth, session: Session): boolean | Promise<boolean>;
}

export interface AppServerOptions {
  host: AgentHost;
  serverInfo?: { name?: string; version?: string };
  access?: AppServerAccessPolicy;
  /** Per-connection outbound queue cap. Defaults to 256 messages. */
  maxOutboundQueue?: number;
}

interface PendingAction {
  id: string;
  kind: 'approval' | 'question' | 'plan';
  accountId?: string;
  sessionId: string;
  runId: string;
}

export class AppServer {
  private readonly host: AgentHost;
  private readonly serverInfo: { name: string; version: string };
  private readonly access: AppServerAccessPolicy;
  private readonly connections = new Set<AppServerConnection>();
  private readonly runToSession = new Map<string, string>();
  private readonly sessionToAccount = new Map<string, string | undefined>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly unsubscribe: () => void;
  private readonly maxOutboundQueue: number;

  constructor(opts: AppServerOptions) {
    this.host = opts.host;
    this.serverInfo = {
      name: opts.serverInfo?.name ?? 'enterprise_agent_app_server',
      version: opts.serverInfo?.version ?? '0.0.7',
    };
    this.access = opts.access ?? { ownsSession: defaultOwnsSession };
    this.maxOutboundQueue = opts.maxOutboundQueue ?? 256;
    this.unsubscribe = this.host.onEvent((event) => void this.handleHostEvent(event));
  }

  createConnection(opts: AppServerConnectionOptions): AppServerConnection {
    const conn = new AppServerConnection(this, opts.auth, opts.send, opts.close, this.maxOutboundQueue);
    this.connections.add(conn);
    return conn;
  }

  unregister(conn: AppServerConnection): void {
    this.connections.delete(conn);
  }

  dispose(): void {
    this.unsubscribe();
    this.connections.clear();
    this.pending.clear();
  }

  async handle(conn: AppServerConnection, raw: string): Promise<void> {
    let id: JsonRpcId = null;
    try {
      const req = parseRequest(raw);
      id = req.id;
      if (req.method !== 'initialize' && !conn.initialized) {
        throw new RpcError(APP_SERVER_ERROR.BAD_LIFECYCLE, 'not initialized');
      }
      const result = await this.dispatch(conn, req.method, req.params);
      await conn.emit(success(req.id, result));
    } catch (err) {
      await conn.emit(failure(id, err));
    }
  }

  private async dispatch(conn: AppServerConnection, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(conn, params);
      case 'session/list':
        return this.sessionList(conn);
      case 'session/create':
        return this.sessionCreate(conn, params);
      case 'session/history':
        return this.sessionHistory(conn, params);
      case 'session/rename':
        return this.sessionRename(conn, params);
      case 'session/delete':
        return this.sessionDelete(conn, params);
      case 'session/todos':
        return this.sessionTodos(conn, params);
      case 'session/compact':
        return this.sessionCompact(conn, params);
      case 'turn/start':
        return this.turnStart(conn, params);
      case 'turn/interrupt':
        return this.turnInterrupt(conn, params);
      case 'approval/respond':
        return this.approvalRespond(conn, params);
      case 'question/respond':
        return this.questionRespond(conn, params);
      case 'plan/respond':
        return this.planRespond(conn, params);
      case 'mode/get':
        return this.modeGet(conn, params);
      case 'mode/set':
        return this.modeSet(conn, params);
      case 'models/list':
        return this.modelsList(conn);
      case 'event/subscribe':
        return this.eventSubscribe(conn, params);
      case 'event/unsubscribe':
        return this.eventUnsubscribe(conn, params);
      default:
        throw new RpcError(APP_SERVER_ERROR.METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  private initialize(conn: AppServerConnection, params: unknown): unknown {
    if (conn.initialized) throw new RpcError(APP_SERVER_ERROR.BAD_LIFECYCLE, 'already initialized');
    const p = asRecord(params, 'initialize params') as unknown as InitializeParams;
    if (!p.clientInfo || typeof p.clientInfo.name !== 'string') {
      throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, 'invalid clientInfo');
    }
    conn.initialized = true;
    conn.optOut = new Set(p.capabilities?.optOutNotificationMethods ?? []);
    return {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      agentProtocolVersion: PROTOCOL_VERSION,
      accountId: conn.auth.accountId,
      serverInfo: this.serverInfo,
    };
  }

  private async sessionList(conn: AppServerConnection): Promise<unknown> {
    const sessions = await this.host.listSessions();
    const visible = [];
    for (const session of sessions) {
      if (await this.canAccessSession(conn, session)) visible.push(session);
    }
    return { sessions: visible };
  }

  private async sessionCreate(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const p = asRecord(params, 'session/create params');
    const name = asString(p.name, 'name');
    const config = isScopedConfig(p.config);
    const session = await this.host.createSession({
      name,
      workingDir: conn.auth.trusted && typeof p.workingDir === 'string' ? p.workingDir : undefined,
      config: this.scopeConfigFor(conn, config),
    });
    this.rememberSession(session, conn.auth.accountId);
    conn.subscribe({ kind: 'session', sessionId: session.id });
    return { session };
  }

  private async sessionHistory(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const sessionId = await this.requireSessionId(conn, params);
    return { tree: await this.host.getSessionTree(sessionId) };
  }

  private async sessionRename(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const p = asRecord(params, 'session/rename params');
    const sessionId = await this.requireSessionId(conn, p);
    const name = asString(p.name, 'name');
    const session = await this.host.renameSession(sessionId, name);
    return { session };
  }

  private async sessionDelete(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const sessionId = await this.requireSessionId(conn, params);
    await this.host.deleteSession(sessionId);
    // Drop the account mapping and any run bookkeeping so a long-lived server
    // doesn't accumulate stale entries (and a re-created id can't inherit the
    // deleted session's owner).
    this.sessionToAccount.delete(sessionId);
    for (const [runId, sid] of this.runToSession) {
      if (sid === sessionId) this.clearRun(runId);
    }
    return {};
  }

  private async sessionTodos(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const sessionId = await this.requireSessionId(conn, params);
    return { todos: await this.host.getTodos(sessionId) };
  }

  private async sessionCompact(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const sessionId = await this.requireSessionId(conn, params);
    await this.host.compact(sessionId);
    return {};
  }

  private async turnStart(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const p = asRecord(params, 'turn/start params');
    const sessionId = await this.requireSessionId(conn, p);
    const input = Array.isArray(p.input) ? (p.input as TurnInputPart[]) : [];
    const { text, parts } = splitTurnInput(input);
    if (!text && parts.length === 0) {
      throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, 'empty input');
    }
    // The host has no per-turn model override (`sendMessage` takes no model).
    // Reject an explicit request instead of silently honoring the session
    // default — a silent drop looks like the override worked when it didn't.
    if (typeof p.model === 'string' && p.model.length > 0) {
      throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, 'per-turn model override is not supported');
    }
    const { runId } = await this.host.sendMessage(sessionId, text, parts.length ? parts : undefined);
    this.trackRun(runId, sessionId, conn.auth.accountId);
    conn.subscribe({ kind: 'run', runId });
    return { runId };
  }

  private async turnInterrupt(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const p = asRecord(params, 'turn/interrupt params');
    const runId = asString(p.runId, 'runId');
    await this.assertRunAccess(conn, runId);
    this.host.abortRun(runId);
    return {};
  }

  private approvalRespond(conn: AppServerConnection, params: unknown): unknown {
    const p = asRecord(params, 'approval/respond params');
    const toolCallId = asString(p.toolCallId, 'toolCallId');
    // Validate the payload before claiming so a malformed decision can't consume
    // the pending action and leave the run wedged.
    const decision = asEnum(p.decision, APPROVAL_DECISIONS, 'decision');
    this.claimPending(conn, toolCallId, 'approval');
    this.host.approveTool(toolCallId, decision);
    return {};
  }

  private questionRespond(conn: AppServerConnection, params: unknown): unknown {
    const p = asRecord(params, 'question/respond params');
    const questionId = asString(p.questionId, 'questionId');
    const answers = p.answers === null ? null : (Array.isArray(p.answers) ? p.answers : undefined);
    if (answers === undefined) throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, 'invalid answers');
    this.claimPending(conn, questionId, 'question');
    this.host.answerQuestion(questionId, answers as UserQuestionAnswer[] | null);
    return {};
  }

  private planRespond(conn: AppServerConnection, params: unknown): unknown {
    const p = asRecord(params, 'plan/respond params');
    const planId = asString(p.planId, 'planId');
    const decision = asEnum(p.decision, PLAN_DECISIONS, 'decision');
    const options = {
      editedPlan: typeof p.editedPlan === 'string' ? p.editedPlan : undefined,
      targetMode:
        p.targetMode === undefined ? undefined : asEnum(p.targetMode, EXECUTION_MODES, 'targetMode'),
    };
    this.claimPending(conn, planId, 'plan');
    this.host.approvePlan(planId, decision, options);
    return {};
  }

  private async modeGet(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const sessionId = await this.requireSessionId(conn, params);
    return { mode: await this.host.getExecutionMode(sessionId) };
  }

  private async modeSet(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const p = asRecord(params, 'mode/set params');
    const sessionId = await this.requireSessionId(conn, p);
    this.host.setExecutionMode(sessionId, asEnum(p.mode, EXECUTION_MODES, 'mode'));
    return {};
  }

  private async modelsList(conn: AppServerConnection): Promise<unknown> {
    const sessions = await this.host.listSessions();
    const aliases = new Map<string, string>();
    for (const session of sessions) {
      if (!(await this.canAccessSession(conn, session))) continue;
      for (const alias of session.config.aliases ?? []) aliases.set(alias.alias, alias.ref);
    }
    return { models: [...aliases].map(([alias, ref]) => ({ alias, ref })) };
  }

  private async eventSubscribe(conn: AppServerConnection, params: unknown): Promise<unknown> {
    const scope = parseScope(params);
    if (scope.kind === 'account' && !conn.auth.trusted) {
      throw new RpcError(APP_SERVER_ERROR.FORBIDDEN, 'account subscription requires trusted client');
    }
    // Session/run subscriptions must be gated the same way session-scoped RPCs are,
    // otherwise any authenticated client could eavesdrop on another account's stream.
    if (scope.kind === 'session') await this.assertSessionAccess(conn, scope.sessionId);
    if (scope.kind === 'run') await this.assertRunAccess(conn, scope.runId);
    conn.subscribe(scope);
    return {};
  }

  private eventUnsubscribe(conn: AppServerConnection, params: unknown): unknown {
    conn.unsubscribe(parseScope(params));
    return {};
  }

  private async requireSessionId(conn: AppServerConnection, params: unknown): Promise<string> {
    const p = asRecord(params, 'session params');
    const sessionId = asString(p.sessionId, 'sessionId');
    await this.assertSessionAccess(conn, sessionId);
    return sessionId;
  }

  private async assertSessionAccess(conn: AppServerConnection, sessionId: string): Promise<void> {
    const session = await this.findSession(sessionId);
    if (!session || !(await this.canAccessSession(conn, session))) {
      throw new RpcError(APP_SERVER_ERROR.NOT_FOUND, 'session not found');
    }
  }

  private async assertRunAccess(conn: AppServerConnection, runId: string): Promise<void> {
    const sessionId = this.runToSession.get(runId);
    if (!sessionId) throw new RpcError(APP_SERVER_ERROR.NOT_FOUND, 'run not found');
    await this.assertSessionAccess(conn, sessionId);
  }

  private async findSession(sessionId: string): Promise<Session | undefined> {
    const sessions = await this.host.listSessions();
    return sessions.find((s) => s.id === sessionId);
  }

  private async canAccessSession(conn: AppServerConnection, session: Session): Promise<boolean> {
    return this.access.ownsSession(conn.auth, session);
  }

  private scopeConfigFor(conn: AppServerConnection, config: ScopedConfig | undefined): ScopedConfig | undefined {
    if (conn.auth.trusted || !conn.auth.accountId) return config;
    // Untrusted (account-scoped) clients must not be able to widen their own
    // execution boundary. Anything security-relevant — executionMode, permission,
    // sandbox, readRoots, plan/auto tuning, dynamicSubAgents, step budget — is
    // stripped rather than forwarded, and the memory namespace is FORCED to the
    // caller's account so it can't read or poison another tenant's memory. Only
    // model selection (which the gate re-checks against capabilities) survives.
    // Allowlist, not denylist: a newly-added ScopedConfig field is dropped by
    // default until it's explicitly deemed safe for untrusted callers.
    return {
      model: config?.model,
      aliases: config?.aliases,
      memoryNamespace: conn.auth.accountId,
    };
  }

  private rememberSession(session: Session, accountId: string | undefined): void {
    this.sessionToAccount.set(session.id, accountId ?? session.config.memoryNamespace);
  }

  private trackRun(runId: string, sessionId: string, accountId: string | undefined): void {
    this.runToSession.set(runId, sessionId);
    if (!this.sessionToAccount.has(sessionId)) this.sessionToAccount.set(sessionId, accountId);
  }

  private claimPending(conn: AppServerConnection, id: string, kind: PendingAction['kind']): void {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== kind) {
      throw new RpcError(APP_SERVER_ERROR.CONFLICT, `no pending ${kind}`);
    }
    if (!conn.auth.trusted && pending.accountId !== conn.auth.accountId) {
      throw new RpcError(APP_SERVER_ERROR.FORBIDDEN, 'pending action belongs to another account');
    }
    this.pending.delete(id);
  }

  private handleHostEvent(event: AgentStreamEvent): void {
    const sessionId = sessionIdForEvent(event, this.runToSession);
    if (!sessionId) return;
    const accountId = this.sessionToAccount.get(sessionId);
    if (event.kind === 'sub-agent-start' || event.kind === 'sub-agent-spawn') {
      this.trackRun(event.runId, sessionId, accountId);
    }
    this.registerPending(event, sessionId, accountId);
    const msg = projectEvent(event, sessionId);
    if (!msg) return;
    for (const conn of this.connections) conn.deliver(sessionId, event, msg);
    if (event.kind === 'run-finish') this.clearRun(event.runId);
  }

  private registerPending(event: AgentStreamEvent, sessionId: string, accountId: string | undefined): void {
    if (event.kind === 'tool-approval-required') {
      this.pending.set(event.toolCallId, { id: event.toolCallId, kind: 'approval', accountId, sessionId, runId: event.runId });
    } else if (event.kind === 'user-question-required') {
      this.pending.set(event.questionId, { id: event.questionId, kind: 'question', accountId, sessionId, runId: event.runId });
    } else if (event.kind === 'plan-proposed') {
      this.pending.set(event.planId, { id: event.planId, kind: 'plan', accountId, sessionId, runId: event.runId });
    }
  }

  private clearRun(runId: string): void {
    this.runToSession.delete(runId);
    for (const [id, pending] of this.pending) {
      if (pending.runId === runId) this.pending.delete(id);
    }
  }
}

export class AppServerConnection {
  initialized = false;
  optOut = new Set<string>();
  private readonly subscriptions = new Set<string>();
  private readonly queue: ServerMessage[] = [];
  private flushing = false;
  private closed = false;

  constructor(
    private readonly server: AppServer,
    readonly auth: AppServerAuth,
    private readonly send: (message: ServerMessage) => void | Promise<void>,
    private readonly closeTransport: (() => void) | undefined,
    private readonly maxOutboundQueue: number,
  ) {}

  receive(raw: string): Promise<void> {
    return this.server.handle(this, raw);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.closeTransport?.();
    this.server.unregister(this);
  }

  emit(message: ServerMessage): Promise<void> {
    this.enqueue(message);
    return Promise.resolve();
  }

  subscribe(scope: SubscriptionScope): void {
    this.subscriptions.add(scopeKey(scope));
  }

  unsubscribe(scope: SubscriptionScope): void {
    this.subscriptions.delete(scopeKey(scope));
  }

  deliver(sessionId: string, event: AgentStreamEvent, message: ServerMessage): void {
    if ('method' in message && this.optOut.has(message.method)) return;
    const runId = 'runId' in event ? event.runId : undefined;
    const parentRunId = 'parentRunId' in event ? event.parentRunId : undefined;
    const subscribed =
      this.subscriptions.has(`session:${sessionId}`) ||
      (runId ? this.subscriptions.has(`run:${runId}`) : false) ||
      (parentRunId ? this.subscriptions.has(`run:${parentRunId}`) : false) ||
      this.subscriptions.has('account');
    if (!subscribed) return;
    if ((event.kind === 'sub-agent-start' || event.kind === 'sub-agent-spawn') && runId) {
      this.subscriptions.add(`run:${runId}`);
    }
    this.enqueue(message);
  }

  private enqueue(message: ServerMessage): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxOutboundQueue) {
      if (isDroppable(message)) return;
      this.close();
      return;
    }
    this.queue.push(message);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const next = this.queue.shift()!;
        await this.send(next);
      }
    } catch {
      this.close();
    } finally {
      this.flushing = false;
    }
  }
}

export function createAppServer(opts: AppServerOptions): AppServer {
  return new AppServer(opts);
}

function defaultOwnsSession(auth: AppServerAuth, session: Session): boolean {
  if (auth.trusted) return true;
  return Boolean(auth.accountId && session.config.memoryNamespace === auth.accountId);
}

function isScopedConfig(value: unknown): ScopedConfig | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ScopedConfig) : undefined;
}

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [APPROVAL.ONCE, APPROVAL.SESSION, APPROVAL.REJECT];
const PLAN_DECISIONS: readonly PlanDecision[] = ['approve', 'edit', 'keep', 'reject'];
const EXECUTION_MODES: readonly ExecutionMode[] = [
  EXECUTION_MODE.ASK,
  EXECUTION_MODE.PLAN,
  EXECUTION_MODE.AUTO,
  EXECUTION_MODE.FULL,
];

/**
 * Validate that a param is one of a fixed set of string literals. Unlike a bare
 * `asString(...) as T` cast, this rejects unknown values BEFORE they reach the
 * host — a malformed `decision`/`mode` would otherwise consume the pending
 * action (via `claimPending`) yet leave the run suspended forever, unrecoverably.
 */
function asEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, `invalid ${name}`);
}

function splitTurnInput(input: TurnInputPart[]): { text: string; parts: UserPart[] } {
  const text: string[] = [];
  const parts: UserPart[] = [];
  for (const part of input) {
    if (part.type === 'text') text.push(part.text);
    else parts.push(part);
  }
  return { text: text.join(''), parts };
}

function parseScope(params: unknown): SubscriptionScope {
  const p = asRecord(params, 'subscription params');
  const kind = asString(p.kind, 'kind');
  if (kind === 'session') return { kind, sessionId: asString(p.sessionId, 'sessionId') };
  if (kind === 'run') return { kind, runId: asString(p.runId, 'runId') };
  if (kind === 'account') return { kind };
  throw new RpcError(APP_SERVER_ERROR.INVALID_PARAMS, 'invalid subscription kind');
}

function scopeKey(scope: SubscriptionScope): string {
  if (scope.kind === 'session') return `session:${scope.sessionId}`;
  if (scope.kind === 'run') return `run:${scope.runId}`;
  return 'account';
}

function sessionIdForEvent(event: AgentStreamEvent, runToSession: Map<string, string>): string | undefined {
  if ('sessionId' in event) return event.sessionId;
  if ('runId' in event) {
    const direct = runToSession.get(event.runId);
    if (direct) return direct;
  }
  if ('parentRunId' in event) return runToSession.get(event.parentRunId);
  return undefined;
}

function projectEvent(event: AgentStreamEvent, sessionId: string): ServerMessage | undefined {
  switch (event.kind) {
    case 'text-delta':
      return notification('item/textDelta', { sessionId, runId: event.runId, agentId: event.agentId, text: event.text });
    case 'reasoning-delta':
      return notification('item/reasoningDelta', { sessionId, runId: event.runId, agentId: event.agentId, text: event.text });
    case 'tool-call':
      return notification('item/toolCall', { sessionId, ...event });
    case 'tool-result':
      return notification('item/toolResult', { sessionId, ...event });
    case 'tool-approval-required':
      return notification('item/approvalRequired', { sessionId, ...event });
    case 'user-question-required':
      return notification('item/questionRequired', { sessionId, ...event });
    case 'plan-proposed':
      return notification('item/planProposed', { sessionId, ...event });
    case 'sub-agent-start':
      return notification('item/subAgentStarted', { sessionId, ...event });
    case 'sub-agent-spawn':
      return notification('item/subAgentSpawned', { sessionId, ...event });
    case 'sub-agent-finish':
      return notification('item/subAgentFinished', { sessionId, ...event });
    case 'sub-agent-eval':
      return notification('item/subAgentEvaluated', { sessionId, ...event });
    case 'usage':
      return notification('item/usage', { sessionId, ...event });
    case 'memory-captured':
      return notification('item/memoryCaptured', { ...event });
    case 'run-finish':
      return notification('turn/completed', { sessionId, runId: event.runId, finishReason: event.finishReason });
    case 'error':
      return notification('item/error', { sessionId, ...event });
    case 'todo-update':
      return notification('session/updated', { sessionId: event.sessionId, todos: event.todos });
    case 'mode-changed':
      return notification('session/updated', { sessionId: event.sessionId, mode: event.mode });
    case 'auto-classified':
      return notification('item/autoClassified', { sessionId, ...event });
    case 'step-finish':
      return notification('item/stepFinish', { sessionId, ...event });
    case 'compaction-start':
      return notification('item/compactionStart', { sessionId, ...event });
    case 'compaction-end':
      return notification('item/compactionEnd', { sessionId, ...event });
    case 'entry-appended':
      return notification('item/entryAppended', { ...event });
    case 'schedule-fired':
      return notification('session/scheduleFired', { ...event });
    case 'schedule-finished':
      return notification('session/scheduleFinished', { ...event });
    default:
      return undefined;
  }
}

function isDroppable(message: ServerMessage): boolean {
  return 'method' in message && (message.method === 'item/textDelta' || message.method === 'item/reasoningDelta');
}
