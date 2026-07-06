/**
 * `ea serve` now exposes the App Server JSON-RPC WebSocket transport. These
 * tests cover the wire behavior CLI depends on: health checks stay HTTP, RPC is
 * under /rpc, bearer auth gates upgrades, and host events arrive as JSON-RPC
 * notifications.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import type { AgentHost, AgentStreamEvent, Session, SessionTree, UserPart } from '@enterprise-agent/agent-contract';
import { startNodeAppServer, type NodeAppServerHandle } from '@enterprise-agent/agent-server/node';

const TOKEN = 'test-token-abc';

class FakeHost implements Partial<AgentHost> {
  readonly sessions: Session[] = [];
  readonly sendMessageCalls: Array<{ sessionId: string; text: string; parts?: UserPart[] }> = [];
  private listener?: (event: AgentStreamEvent) => void;
  private nextSession = 1;
  private nextRun = 1;

  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }

  async createSession(input: { name: string; workingDir?: string; config?: Record<string, unknown> }): Promise<Session> {
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

  async sendMessage(sessionId: string, text: string, parts?: UserPart[]): Promise<{ runId: string }> {
    this.sendMessageCalls.push({ sessionId, text, parts });
    return { runId: `r_${this.nextRun++}` };
  }

  async getSessionTree(sessionId: string): Promise<SessionTree> {
    return { rootId: `${sessionId}_root`, nodes: {}, labels: {} };
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

let host: FakeHost;
let handle: NodeAppServerHandle;

beforeEach(async () => {
  host = new FakeHost();
  handle = await startNodeAppServer({
    agentHost: host.asHost(),
    port: await freePort(),
    rpcPath: '/rpc',
    log: () => {},
    authenticate: (req) => {
      const header = req.headers.authorization;
      return header === `Bearer ${TOKEN}` ? { trusted: true } : undefined;
    },
    originAllowed: (req) => {
      const origin = req.headers.origin;
      if (!origin) return true;
      return new URL(origin).host === req.headers.host;
    },
  });
});

afterEach(async () => {
  await handle.dispose();
});

describe('ea serve app-server transport', () => {
  it('serves health checks without auth and keeps old REST routes absent', async () => {
    expect(await (await fetch(`${handle.url}/healthz`)).text()).toBe('ok\n');
    expect((await fetch(`${handle.url}/readyz`)).status).toBe(200);
    expect((await fetch(`${handle.url}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
  });

  it('rejects /rpc WebSocket upgrades without the bearer token', async () => {
    await expect(connectRpc(handle.rpcUrl)).rejects.toThrow();
  });

  it('initializes over /rpc and routes session/create + turn/start', async () => {
    const rpc = await connectRpc(handle.rpcUrl, { authorization: `Bearer ${TOKEN}` });
    try {
      const init = await rpc.request('initialize', { clientInfo: { name: 'cli-test' } });
      expect(init).toMatchObject({ protocolVersion: 1, serverInfo: { name: 'enterprise_agent_app_server' } });

      const created = await rpc.request('session/create', { name: 'CLI served session' }) as { session: Session };
      expect(created.session).toMatchObject({ id: 's_1', name: 'CLI served session' });

      const turn = await rpc.request('turn/start', {
        sessionId: created.session.id,
        input: [{ type: 'text', text: 'hello over rpc' }],
      });
      expect(turn).toEqual({ runId: 'r_1' });
      expect(host.sendMessageCalls).toEqual([{ sessionId: 's_1', text: 'hello over rpc', parts: undefined }]);
    } finally {
      rpc.close();
    }
  });

  it('fans host events out as app-server notifications', async () => {
    const rpc = await connectRpc(handle.rpcUrl, { authorization: `Bearer ${TOKEN}` });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'cli-test' } });
      const created = await rpc.request('session/create', { name: 'Events' }) as { session: Session };
      const turn = await rpc.request('turn/start', {
        sessionId: created.session.id,
        input: [{ type: 'text', text: 'stream' }],
      }) as { runId: string };

      host.emit({ kind: 'text-delta', runId: turn.runId, agentId: 'orch', text: 'hi' });
      const note = await rpc.nextNotification();
      expect(note).toMatchObject({ method: 'item/textDelta', params: { sessionId: 's_1', runId: 'r_1', text: 'hi' } });
    } finally {
      rpc.close();
    }
  });
});

interface RpcHarness {
  request(method: string, params: unknown): Promise<unknown>;
  nextNotification(): Promise<{ method: string; params?: unknown }>;
  close(): void;
}

function connectRpc(url: string, headers: Record<string, string> = {}): Promise<RpcHarness> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const pending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();
    const notifications: Array<{ method: string; params?: unknown }> = [];
    let notificationWaiter: ((value: { method: string; params?: unknown }) => void) | undefined;
    let nextId = 1;

    ws.once('open', () => {
      resolve({
        request(method, params) {
          const id = nextId++;
          const p = new Promise<unknown>((res, rej) => pending.set(id, { resolve: res, reject: rej }));
          ws.send(JSON.stringify({ id, method, params }));
          return p;
        },
        nextNotification() {
          const existing = notifications.shift();
          if (existing) return Promise.resolve(existing);
          return new Promise((res) => {
            notificationWaiter = res;
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected response ${res.statusCode}`));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      if (msg.method) {
        const note = { method: msg.method, params: msg.params };
        if (notificationWaiter) {
          const waiter = notificationWaiter;
          notificationWaiter = undefined;
          waiter(note);
        } else {
          notifications.push(note);
        }
        return;
      }
      const waiter = pending.get(msg.id!);
      if (!waiter) return;
      pending.delete(msg.id!);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}
