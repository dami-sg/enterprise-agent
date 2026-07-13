import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  AgentHost,
  AgentStreamEvent,
  ApprovalDecision,
  ExecutionMode,
  PlanDecision,
  ScopedConfig,
  Session,
  SessionTree,
  Todo,
  UserQuestionAnswer,
} from '@dami-sg/agent-contract';
import { APPROVAL } from '@dami-sg/agent-contract';
import { APP_SERVER_ERROR, AppServer, type ServerMessage } from '../src/index.js';
import { startNodeAppServer } from '../src/node.js';

class TestClientError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

class TestClient {
  private id = 1;
  readonly notifications: Array<{ method: string; params?: unknown }> = [];

  constructor(private readonly sendRaw: (raw: string) => Promise<void> | void) {}

  initialize(name: string): Promise<unknown> {
    return this.request('initialize', { clientInfo: { name } });
  }

  startTurn(sessionId: string, input: Array<{ type: 'text'; text: string }>): Promise<{ runId: string }> {
    return this.request('turn/start', { sessionId, input });
  }

  startTurnRaw(params: unknown): Promise<{ runId: string }> {
    return this.request('turn/start', params);
  }

  createSession(params: unknown): Promise<{ session: Session }> {
    return this.request('session/create', params);
  }

  setMode(sessionId: string, mode: unknown): Promise<unknown> {
    return this.request('mode/set', { sessionId, mode });
  }

  respondToPlanRaw(planId: string, decision: unknown, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('plan/respond', { planId, decision, ...extra });
  }

  subscribe(params: { kind: 'session'; sessionId: string } | { kind: 'run'; runId: string }): Promise<unknown> {
    return this.request('event/subscribe', params);
  }

  history(sessionId: string): Promise<unknown> {
    return this.request('session/history', { sessionId });
  }

  respondToApproval(toolCallId: string, decision: ApprovalDecision): Promise<unknown> {
    return this.request('approval/respond', { toolCallId, decision });
  }

  respondToApprovalRaw(toolCallId: string, decision: unknown): Promise<unknown> {
    return this.request('approval/respond', { toolCallId, decision });
  }

  interrupt(runId: string): Promise<unknown> {
    return this.request('turn/interrupt', { runId });
  }

  close(closeConn: () => void): void {
    closeConn();
  }

  receive(raw: string): void {
    const msg = JSON.parse(raw) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    if (msg.method) {
      this.notifications.push({ method: msg.method, params: msg.params });
      return;
    }
    const pending = this.pending.get(msg.id!);
    if (!pending) return;
    this.pending.delete(msg.id!);
    if (msg.error) pending.reject(new TestClientError(msg.error.code, msg.error.message));
    else pending.resolve(msg.result);
  }

  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();

  private request<T>(method: string, params: unknown): Promise<T> {
    const id = this.id++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: (v) => resolve(v as T), reject }));
    void Promise.resolve(this.sendRaw(JSON.stringify({ id, method, params }))).catch((err) => {
      this.pending.delete(id);
      throw err;
    });
    return p;
  }
}

class FakeHost implements Partial<AgentHost> {
  readonly protocolVersion = 1;
  readonly sessions: Session[] = [];
  readonly calls = {
    sendMessage: [] as Array<{ sessionId: string; text: string }>,
    approveTool: [] as Array<{ toolCallId: string; decision: ApprovalDecision }>,
    answerQuestion: [] as Array<{ questionId: string; answers: UserQuestionAnswer[] | null }>,
    approvePlan: [] as Array<{ planId: string; decision: PlanDecision }>,
    abortRun: [] as string[],
  };
  private listener?: (event: AgentStreamEvent) => void;
  private nextSession = 1;
  private nextRun = 1;

  seedSession(accountId: string): Session {
    const session = {
      id: `s_${this.nextSession++}`,
      name: 'Seed',
      config: { memoryNamespace: accountId },
      isActive: false,
      status: 'active',
      todos: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cost: 0 },
    } as Session;
    this.sessions.push(session);
    return session;
  }

  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }

  async createSession(input: { name: string; workingDir?: string; config?: ScopedConfig }): Promise<Session> {
    const session = {
      id: `s_${this.nextSession++}`,
      name: input.name,
      workingDir: input.workingDir,
      config: input.config ?? {},
      isActive: false,
      status: 'active',
      todos: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cost: 0 },
    } as Session;
    this.sessions.push(session);
    return session;
  }

  async sendMessage(sessionId: string, text: string): Promise<{ runId: string }> {
    this.calls.sendMessage.push({ sessionId, text });
    return { runId: `r_${this.nextRun++}` };
  }

  approveTool(toolCallId: string, decision: ApprovalDecision): void {
    this.calls.approveTool.push({ toolCallId, decision });
  }

  answerQuestion(questionId: string, answers: UserQuestionAnswer[] | null): void {
    this.calls.answerQuestion.push({ questionId, answers });
  }

  approvePlan(planId: string, decision: PlanDecision): void {
    this.calls.approvePlan.push({ planId, decision });
  }

  abortRun(runId: string): void {
    this.calls.abortRun.push(runId);
  }

  async getSessionTree(sessionId: string): Promise<SessionTree> {
    return { rootId: `${sessionId}_root`, nodes: {}, labels: {} };
  }

  async getTodos(): Promise<Todo[]> {
    return [];
  }

  async renameSession(sessionId: string, name: string): Promise<Session> {
    const session = this.sessions.find((s) => s.id === sessionId)!;
    session.name = name;
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const idx = this.sessions.findIndex((s) => s.id === sessionId);
    if (idx >= 0) this.sessions.splice(idx, 1);
  }

  async compact(): Promise<void> {}

  setExecutionMode(): void {}

  async getExecutionMode(): Promise<ExecutionMode> {
    return 'ask';
  }

  onEvent(listener: (event: AgentStreamEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  emit(event: AgentStreamEvent): void {
    this.listener?.(event);
  }

  asHost(): AgentHost {
    return this as AgentHost;
  }
}

describe('AppServer MVP behavior', () => {
  it('routes events to two clients subscribed to different sessions without cross-talk', async () => {
    const host = new FakeHost();
    const a = host.seedSession('acct_a');
    const b = host.seedSession('acct_b');
    const server = new AppServer({ host: host.asHost() });
    const clientA = connectClient(server, { accountId: 'acct_a' });
    const clientB = connectClient(server, { accountId: 'acct_b' });
    await clientA.client.initialize('a');
    await clientB.client.initialize('b');

    const runA = await clientA.client.startTurn(a.id, [{ type: 'text', text: 'hello a' }]);
    const runB = await clientB.client.startTurn(b.id, [{ type: 'text', text: 'hello b' }]);
    host.emit({ kind: 'text-delta', runId: runA.runId, agentId: 'orch', text: 'A' });
    host.emit({ kind: 'text-delta', runId: runB.runId, agentId: 'orch', text: 'B' });
    await tick();

    expect(clientA.client.notifications.map((n) => (n.params as { text?: string }).text).filter(Boolean)).toEqual(['A']);
    expect(clientB.client.notifications.map((n) => (n.params as { text?: string }).text).filter(Boolean)).toEqual(['B']);
  });

  it('fans out the same session stream to two clients for the same account', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const one = connectClient(server, { accountId: 'acct_a' });
    const two = connectClient(server, { accountId: 'acct_a' });
    await one.client.initialize('one');
    await two.client.initialize('two');
    await one.client.subscribe({ kind: 'session', sessionId: session.id });
    await two.client.subscribe({ kind: 'session', sessionId: session.id });

    const { runId } = await one.client.startTurn(session.id, [{ type: 'text', text: 'shared' }]);
    host.emit({ kind: 'text-delta', runId, agentId: 'orch', text: 'shared-delta' });
    await tick();

    expect(one.client.notifications.some((n) => n.method === 'item/textDelta')).toBe(true);
    expect(two.client.notifications.some((n) => n.method === 'item/textDelta')).toBe(true);
  });

  it('hides another account session history as not found', async () => {
    const host = new FakeHost();
    const b = host.seedSession('acct_b');
    const server = new AppServer({ host: host.asHost() });
    const clientA = connectClient(server, { accountId: 'acct_a' });
    await clientA.client.initialize('a');

    await expect(clientA.client.history(b.id)).rejects.toMatchObject({
      code: APP_SERVER_ERROR.NOT_FOUND,
    } satisfies Partial<TestClientError>);
  });

  it('allows only the owning account to answer an approval once', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const owner = connectClient(server, { accountId: 'acct_a' });
    const other = connectClient(server, { accountId: 'acct_b' });
    await owner.client.initialize('owner');
    await other.client.initialize('other');

    const { runId } = await owner.client.startTurn(session.id, [{ type: 'text', text: 'needs approval' }]);
    host.emit({
      kind: 'tool-approval-required',
      runId,
      agentId: 'orch',
      toolCallId: 'tc_1',
      toolName: 'runCommand',
      input: { cmd: 'npm test' },
    });
    await tick();

    await expect(other.client.respondToApproval('tc_1', APPROVAL.ONCE)).rejects.toMatchObject({
      code: APP_SERVER_ERROR.FORBIDDEN,
    } satisfies Partial<TestClientError>);
    await owner.client.respondToApproval('tc_1', APPROVAL.ONCE);
    await expect(owner.client.respondToApproval('tc_1', APPROVAL.ONCE)).rejects.toMatchObject({
      code: APP_SERVER_ERROR.CONFLICT,
    } satisfies Partial<TestClientError>);
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'tc_1', decision: APPROVAL.ONCE }]);
  });

  it('refuses to subscribe to another account session', async () => {
    const host = new FakeHost();
    const b = host.seedSession('acct_b');
    const server = new AppServer({ host: host.asHost() });
    const clientA = connectClient(server, { accountId: 'acct_a' });
    await clientA.client.initialize('a');

    await expect(clientA.client.subscribe({ kind: 'session', sessionId: b.id })).rejects.toMatchObject({
      code: APP_SERVER_ERROR.NOT_FOUND,
    } satisfies Partial<TestClientError>);
  });

  it('does not leak stream events to a foreign account that forced a subscription', async () => {
    const host = new FakeHost();
    const owner = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const attacker = connectClient(server, { accountId: 'acct_b' });
    await attacker.client.initialize('attacker');
    await attacker.client
      .subscribe({ kind: 'session', sessionId: owner.id })
      .catch(() => undefined);

    const ownerClient = connectClient(server, { accountId: 'acct_a' });
    await ownerClient.client.initialize('owner');
    const { runId } = await ownerClient.client.startTurn(owner.id, [{ type: 'text', text: 'private' }]);
    host.emit({ kind: 'text-delta', runId, agentId: 'orch', text: 'secret output' });
    await tick();

    expect(attacker.client.notifications.some((n) => n.method === 'item/textDelta')).toBe(false);
  });

  it('refuses to interrupt a run owned by another account', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const owner = connectClient(server, { accountId: 'acct_a' });
    const other = connectClient(server, { accountId: 'acct_b' });
    await owner.client.initialize('owner');
    await other.client.initialize('other');
    const { runId } = await owner.client.startTurn(session.id, [{ type: 'text', text: 'long task' }]);

    await expect(other.client.interrupt(runId)).rejects.toMatchObject({
      code: APP_SERVER_ERROR.NOT_FOUND,
    } satisfies Partial<TestClientError>);
    expect(host.calls.abortRun).toEqual([]);

    await owner.client.interrupt(runId);
    expect(host.calls.abortRun).toEqual([runId]);
  });

  it('does not consume a pending approval when the decision is malformed', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const owner = connectClient(server, { accountId: 'acct_a' });
    await owner.client.initialize('owner');
    const { runId } = await owner.client.startTurn(session.id, [{ type: 'text', text: 'needs approval' }]);
    host.emit({
      kind: 'tool-approval-required',
      runId,
      agentId: 'orch',
      toolCallId: 'tc_1',
      toolName: 'runCommand',
      input: { cmd: 'npm test' },
    });
    await tick();

    await expect(owner.client.respondToApprovalRaw('tc_1', '')).rejects.toMatchObject({
      code: APP_SERVER_ERROR.INVALID_PARAMS,
    } satisfies Partial<TestClientError>);
    // The pending approval survives and can still be answered.
    await owner.client.respondToApproval('tc_1', APPROVAL.ONCE);
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'tc_1', decision: APPROVAL.ONCE }]);
  });

  it('keeps a turn running after a client disconnects and allows reconnect/history', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const first = connectClient(server, { accountId: 'acct_a' });
    await first.client.initialize('first');
    const { runId } = await first.client.startTurn(session.id, [{ type: 'text', text: 'long task' }]);

    first.close();
    host.emit({ kind: 'run-finish', runId, finishReason: 'stop' });

    const second = connectClient(server, { accountId: 'acct_a' });
    await second.client.initialize('second');
    await expect(second.client.history(session.id)).resolves.toMatchObject({ tree: { rootId: `${session.id}_root` } });
  });

  it('does not block host event dispatch on a slow client', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost(), maxOutboundQueue: 2 });
    const slow = server.createConnection({
      auth: { accountId: 'acct_a' },
      send: () => new Promise<void>(() => {}),
    });
    await slow.receive(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'slow' } } }));
    await slow.receive(JSON.stringify({ id: 2, method: 'event/subscribe', params: { kind: 'session', sessionId: session.id } }));

    const fast = connectClient(server, { accountId: 'acct_a' });
    await fast.client.initialize('fast');
    await fast.client.subscribe({ kind: 'session', sessionId: session.id });
    const { runId } = await fast.client.startTurn(session.id, [{ type: 'text', text: 'fast path' }]);
    host.emit({ kind: 'text-delta', runId, agentId: 'orch', text: 'still delivered' });
    await tick();

    expect(fast.client.notifications.some((n) => n.method === 'item/textDelta')).toBe(true);
  });

  it('tracks sub-agent run ids through parentRunId', async () => {
    const host = new FakeHost();
    const session = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('client');
    const { runId } = await client.client.startTurn(session.id, [{ type: 'text', text: 'delegate' }]);

    host.emit({ kind: 'sub-agent-start', runId: 'sub_1', parentRunId: runId, parentAgentId: 'orch', agentId: 'sub', role: 'worker' });
    host.emit({ kind: 'text-delta', runId: 'sub_1', agentId: 'sub', text: 'sub output' });
    await tick();

    expect(client.client.notifications.map((n) => n.method)).toContain('item/subAgentStarted');
    expect(client.client.notifications.some((n) => n.method === 'item/textDelta' && (n.params as { text?: string }).text === 'sub output')).toBe(true);
  });

  it('serves JSON-RPC over the real WebSocket /rpc listener', async () => {
    const host = new FakeHost();
    const handle = await startNodeAppServer({
      agentHost: host.asHost(),
      port: 0,
      authenticate: () => ({ trusted: true }),
    });
    try {
      const port = (handle.server.address() as { port: number }).port;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
      await onceOpen(ws);
      ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'ws-test' } } }));
      const msg = JSON.parse(await onceMessage(ws)) as { id: number; result?: { protocolVersion?: number } };
      expect(msg).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
      ws.close();
    } finally {
      await handle.dispose();
    }
  });
});

describe('AppServer trust boundary & protocol validation', () => {
  it('strips security-sensitive config and forces memoryNamespace for untrusted clients', async () => {
    const host = new FakeHost();
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');

    const { session } = await client.client.createSession({
      name: 'escalate',
      config: {
        executionMode: 'full',
        sandbox: { enabled: false },
        permission: { allowCommands: ['bash'] },
        readRoots: ['/'],
        maxSteps: 9999,
        memoryNamespace: 'victim',
        model: { ref: 'anthropic:claude-sonnet-4.5' },
      },
    });

    expect(session.config.executionMode).toBeUndefined();
    expect(session.config.sandbox).toBeUndefined();
    expect(session.config.permission).toBeUndefined();
    expect(session.config.readRoots).toBeUndefined();
    expect(session.config.maxSteps).toBeUndefined();
    // Memory namespace is forced to the caller's account, not the spoofed value.
    expect(session.config.memoryNamespace).toBe('acct_a');
    // Harmless model selection survives.
    expect(session.config.model).toEqual({ ref: 'anthropic:claude-sonnet-4.5' });
  });

  it('passes config through unchanged for trusted clients', async () => {
    const host = new FakeHost();
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a', trusted: true });
    await client.client.initialize('a');

    const { session } = await client.client.createSession({
      name: 'trusted',
      config: { executionMode: 'full', sandbox: { enabled: false }, memoryNamespace: 'ns' },
    });

    expect(session.config.executionMode).toBe('full');
    expect(session.config.sandbox).toEqual({ enabled: false });
    expect(session.config.memoryNamespace).toBe('ns');
  });

  it('rejects an unsupported per-turn model override instead of silently ignoring it', async () => {
    const host = new FakeHost();
    const s = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');

    await expect(
      client.client.startTurnRaw({ sessionId: s.id, input: [{ type: 'text', text: 'hi' }], model: 'anthropic:x' }),
    ).rejects.toMatchObject({ code: APP_SERVER_ERROR.INVALID_PARAMS } satisfies Partial<TestClientError>);
    expect(host.calls.sendMessage).toEqual([]);
  });

  it('starts a turn when model is absent', async () => {
    const host = new FakeHost();
    const s = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');

    await client.client.startTurnRaw({ sessionId: s.id, input: [{ type: 'text', text: 'hi' }] });
    expect(host.calls.sendMessage).toEqual([{ sessionId: s.id, text: 'hi' }]);
  });

  it('rejects an invalid execution mode without reaching the host', async () => {
    const host = new FakeHost();
    const s = host.seedSession('acct_a');
    let modeSetCalls = 0;
    host.setExecutionMode = () => {
      modeSetCalls++;
    };
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');

    await expect(client.client.setMode(s.id, 'turbo')).rejects.toMatchObject({
      code: APP_SERVER_ERROR.INVALID_PARAMS,
    } satisfies Partial<TestClientError>);
    expect(modeSetCalls).toBe(0);
  });

  it('rejects an invalid plan decision without consuming the pending plan', async () => {
    const host = new FakeHost();
    const s = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');
    const { runId } = await client.client.startTurn(s.id, [{ type: 'text', text: 'plan it' }]);
    host.emit({ kind: 'plan-proposed', runId, agentId: 'orch', planId: 'p1', plan: 'do it' });
    await tick();

    await expect(client.client.respondToPlanRaw('p1', 'maybe')).rejects.toMatchObject({
      code: APP_SERVER_ERROR.INVALID_PARAMS,
    } satisfies Partial<TestClientError>);
    // The pending plan survives a malformed decision and can still be answered.
    await client.client.respondToPlanRaw('p1', 'approve');
    expect(host.calls.approvePlan).toEqual([{ planId: 'p1', decision: 'approve' }]);
  });

  it('projects auto-classified and schedule-finished events to run subscribers', async () => {
    const host = new FakeHost();
    const s = host.seedSession('acct_a');
    const server = new AppServer({ host: host.asHost() });
    const client = connectClient(server, { accountId: 'acct_a' });
    await client.client.initialize('a');
    const { runId } = await client.client.startTurn(s.id, [{ type: 'text', text: 'go' }]);

    host.emit({ kind: 'auto-classified', runId, agentId: 'orch', toolCallId: 't1', verdict: 'allow', reason: 'safe' });
    host.emit({ kind: 'schedule-finished', name: 'daily', sessionId: s.id, runId, status: 'done', summary: 'ok' });
    await tick();

    const methods = client.client.notifications.map((n) => n.method);
    expect(methods).toContain('item/autoClassified');
    expect(methods).toContain('session/scheduleFinished');
  });
});

function connectClient(server: AppServer, auth: { accountId?: string; trusted?: boolean }): {
  client: TestClient;
  close(): void;
} {
  let client: TestClient;
  const conn = server.createConnection({
    auth,
    send: (message: ServerMessage) => client.receive(JSON.stringify(message)),
  });
  client = new TestClient((raw) => conn.receive(raw));
  return { client, close: () => conn.close() };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function onceMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString('utf8')));
  });
}
