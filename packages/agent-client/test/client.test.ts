import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentHost, AgentStreamEvent, Session } from '@dami-sg/agent-contract';
import { APP_SERVER_PROTOCOL_VERSION } from '@dami-sg/agent-server';
import { startNodeAppServer } from '@dami-sg/agent-server/node';
import { AgentClient, type AgentClientTransport } from '../src/client.js';
import { createWebSocketTransport } from '../src/websocket.js';

/** Controllable in-memory transport for deterministic client-behavior tests. */
class FakeTransport implements AgentClientTransport {
  readonly sent: string[] = [];
  private msg?: (raw: string) => void;
  private closed?: () => void;

  send(raw: string): void {
    this.sent.push(raw);
  }
  onMessage(listener: (raw: string) => void): () => void {
    this.msg = listener;
    return () => {
      this.msg = undefined;
    };
  }
  onClose(listener: () => void): () => void {
    this.closed = listener;
    return () => {
      this.closed = undefined;
    };
  }

  deliver(raw: string): void {
    this.msg?.(raw);
  }
  drop(): void {
    this.closed?.();
  }
  lastRequest(): { id: number; method: string; params: unknown } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
  respond(id: number, result: unknown): void {
    this.deliver(JSON.stringify({ id, result }));
  }
}

class FakeHost implements Partial<AgentHost> {
  readonly protocolVersion = 1;
  private listener?: (event: AgentStreamEvent) => void;
  readonly session: Session = {
    id: 's_1',
    name: 'Test',
    config: { memoryNamespace: 'acct_a' },
    isActive: false,
    status: 'active',
    todos: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cost: 0 },
  } as Session;

  async listSessions(): Promise<Session[]> {
    return [this.session];
  }

  async sendMessage(): Promise<{ runId: string }> {
    return { runId: 'r_1' };
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

describe('AgentClient WebSocket transport', () => {
  it('initializes, starts a turn, and receives notifications over /rpc', async () => {
    const host = new FakeHost();
    const handle = await startNodeAppServer({
      agentHost: host.asHost(),
      port: 0,
      authenticate: () => ({ accountId: 'acct_a' }),
    });
    const port = (handle.server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    await onceOpen(ws);

    const client = new AgentClient({ transport: createWebSocketTransport(ws) });
    const notifications: Array<{ method: string; params?: unknown }> = [];
    client.onNotification((n) => notifications.push(n));

    try {
      await expect(client.initialize({ clientInfo: { name: 'sdk-test' } })).resolves.toMatchObject({
        accountId: 'acct_a',
        protocolVersion: 1,
      });
      await expect(client.listSessions()).resolves.toMatchObject({ sessions: [{ id: 's_1' }] });
      await expect(client.startTurn('s_1', [{ type: 'text', text: 'hello' }])).resolves.toEqual({ runId: 'r_1' });
      host.emit({ kind: 'text-delta', runId: 'r_1', agentId: 'orch', text: 'hello back' });
      await waitFor(() => notifications.some((n) => n.method === 'item/textDelta'));
      expect(notifications).toContainEqual({
        method: 'item/textDelta',
        params: { sessionId: 's_1', runId: 'r_1', agentId: 'orch', text: 'hello back' },
      });
    } finally {
      await client.close();
      await handle.dispose();
    }
  });
});

describe('AgentClient robustness', () => {
  it('rejects every in-flight request when the connection drops', async () => {
    const transport = new FakeTransport();
    const client = new AgentClient({ transport });
    const pending = client.listSessions();
    transport.drop();
    await expect(pending).rejects.toThrow(/connection lost/);
    // And a request issued after the drop fails fast instead of hanging.
    await expect(client.listSessions()).rejects.toThrow(/closed/);
  });

  it('rejects at the handshake when the server protocol version differs', async () => {
    const transport = new FakeTransport();
    const client = new AgentClient({ transport });
    const pending = client.initialize({ clientInfo: { name: 'x' } });
    const req = transport.lastRequest();
    transport.respond(req.id, {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION + 1,
      agentProtocolVersion: 1,
      serverInfo: { name: 's', version: '1' },
    });
    await expect(pending).rejects.toThrow(/protocol version mismatch/);
  });

  it('resolves the handshake when the protocol version matches', async () => {
    const transport = new FakeTransport();
    const client = new AgentClient({ transport });
    const pending = client.initialize({ clientInfo: { name: 'x' } });
    const req = transport.lastRequest();
    transport.respond(req.id, {
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      agentProtocolVersion: 1,
      accountId: 'acct_a',
      serverInfo: { name: 's', version: '1' },
    });
    await expect(pending).resolves.toMatchObject({ accountId: 'acct_a' });
  });

  it('base64-encodes Uint8Array part data so it survives JSON transport', () => {
    const transport = new FakeTransport();
    const client = new AgentClient({ transport });
    const bytes = new Uint8Array([1, 2, 3, 255]);
    void client.startTurn('s_1', [{ type: 'image', data: bytes, mediaType: 'image/png' }]);

    const params = transport.lastRequest().params as { input: Array<{ data: unknown }> };
    const encoded = params.input[0].data;
    expect(typeof encoded).toBe('string');
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    // Crucially not the corrupt `{"0":1,...}` object shape.
    expect(encoded).not.toMatch(/^\{/);
  });
});

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
