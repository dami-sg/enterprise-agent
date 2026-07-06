import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentHost, AgentStreamEvent, Session } from '@enterprise-agent/agent-contract';
import { startNodeAppServer } from '@enterprise-agent/agent-server/node';
import { AgentClient } from '../src/client.js';
import { createWebSocketTransport } from '../src/websocket.js';

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
