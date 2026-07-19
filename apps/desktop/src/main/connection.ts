/**
 * App-server connection manager (desktop-app §7 / §9.2). The MAIN process owns
 * the WebSocket — the remote bearer key rides the upgrade's `Authorization`
 * header (which a renderer WebSocket cannot set) and never enters the renderer.
 * Requests/notifications are relayed over IPC.
 *
 * Reconnect (app-server §8.1): the renderer re-pulls history on 'connected';
 * here we just re-dial with backoff while a target is desired. When the
 * supervisor is restarting the local sidecar, the phase reads
 * 'gateway-restarting' so the chat层 shows an expected-restart notice (§7).
 */
import WebSocket from 'ws';
import { AgentClient, createWebSocketTransport } from '@dami-sg/agent-client';
import type { RpcState } from '../shared/ipc.js';

export interface ConnectionTarget {
  url: string;
  /** Remote bearer access key (never persisted here — read per-dial). */
  token?: string;
}

export interface ConnectionDeps {
  clientVersion: string;
  onState: (state: RpcState) => void;
  onNotification: (n: { method: string; params?: unknown }) => void;
  log?: (line: string) => void;
  backoffMs?: number[];
}

export class ConnectionManager {
  private client?: AgentClient;
  private socket?: WebSocket;
  private target?: ConnectionTarget;
  private state: RpcState = { phase: 'idle' };
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private gatewayRestarting = false;
  private generation = 0;
  private readonly backoffMs: number[];

  constructor(private readonly deps: ConnectionDeps) {
    this.backoffMs = deps.backoffMs ?? [1000, 2000, 5000, 10_000];
  }

  currentState(): RpcState {
    return this.state;
  }

  /** Dial (or re-dial) a target; `undefined` disconnects. */
  setTarget(target: ConnectionTarget | undefined): void {
    this.target = target;
    this.retry = 0;
    this.disposeSocket();
    if (!target) {
      this.publish({ phase: 'idle' });
      return;
    }
    this.dial();
  }

  /** Supervisor hook: tag the drop as an expected sidecar restart (§7). */
  setGatewayRestarting(restarting: boolean): void {
    if (this.gatewayRestarting === restarting) return;
    this.gatewayRestarting = restarting;
    if (!this.client && this.target) {
      this.publish({ ...this.state, phase: restarting ? 'gateway-restarting' : this.state.phase });
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (!this.client) throw new Error('未连接到网关');
    // Ceiling on any single request: a socket that stalls silently (accepted
    // but never answered) must not hang an IPC handler / chunked download
    // forever. Generous because compaction/titling can be legitimately slow.
    const timeoutMs = 300_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.client.request(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`RPC 超时（${timeoutMs / 1000}s）：${method}`)), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  dispose(): void {
    this.target = undefined;
    this.disposeSocket();
    this.publish({ phase: 'idle' });
  }

  private dial(): void {
    const target = this.target;
    if (!target) return;
    const gen = ++this.generation;
    this.publish({
      phase: this.gatewayRestarting ? 'gateway-restarting' : this.retry ? 'reconnecting' : 'connecting',
      url: target.url,
    });

    const socket = new WebSocket(target.url, {
      headers: target.token ? { authorization: `Bearer ${target.token}` } : {},
      handshakeTimeout: 10_000,
    });
    this.socket = socket;

    socket.on('open', () => {
      if (gen !== this.generation) return socket.close();
      void this.handshake(socket, gen, target);
    });
    socket.on('error', (err) => {
      if (gen !== this.generation) return;
      this.deps.log?.(`[rpc] 连接错误：${(err as Error).message}`);
    });
    // Auth happens at the WebSocket UPGRADE (gateway-consolidation §4.3): a bad
    // or expired bearer key is an HTTP 401/403 here, not a JSON-RPC error.
    // Surface it as the auth-error phase and STOP retrying — re-dialing with the
    // same key can't succeed; the UI guides re-entering it (§3.3).
    socket.on('unexpected-response', (_req, res) => {
      if (gen !== this.generation) return;
      const code = res.statusCode ?? 0;
      this.deps.log?.(`[rpc] upgrade 被拒：HTTP ${code}`);
      if (code === 401 || code === 403) {
        this.generation++; // invalidate the pending 'close' → no retry
        socket.terminate();
        this.publish({
          phase: 'error',
          error: `鉴权失败（HTTP ${code}）`,
          errorCode: -32002,
          url: target.url,
        });
        return;
      }
      // Other statuses (502 from a proxy, etc.): retry explicitly — a refused
      // upgrade may not emit 'close', so don't depend on it.
      this.generation++;
      socket.terminate();
      this.scheduleRetry(target);
    });
    socket.on('close', () => {
      if (gen !== this.generation) return;
      this.client = undefined;
      this.scheduleRetry(target);
    });
  }

  private async handshake(socket: WebSocket, gen: number, target: ConnectionTarget): Promise<void> {
    const client = new AgentClient({
      transport: createWebSocketTransport(socket as never),
    });
    try {
      const init = await client.initialize({
        clientInfo: {
          name: 'enterprise_desktop',
          title: 'Enterprise Agent Desktop',
          version: this.deps.clientVersion,
        },
        capabilities: { experimental: false },
      });
      if (gen !== this.generation) return void client.close();
      this.client = client;
      this.retry = 0;
      client.onNotification((n) => this.deps.onNotification(n));
      // Desktop is a trusted rich client → account-wide events (app-server §4.3).
      // Servers may refuse (-32003) for remote clients; per-session subscribe
      // still happens renderer-side, so a refusal is non-fatal.
      await client.subscribe({ kind: 'account' }).catch(() => {});
      this.publish({ phase: 'connected', accountId: init.accountId, url: target.url });
    } catch (err) {
      if (gen !== this.generation) return;
      const e = err as { code?: number; message?: string };
      this.deps.log?.(`[rpc] 握手失败：${e.message ?? String(err)}`);
      // Auth failures (-32002) don't retry — the UI guides re-entering the key (§3.3).
      if (e.code === -32002) {
        this.generation++;
        this.disposeSocket();
        this.publish({ phase: 'error', error: e.message, errorCode: e.code, url: target.url });
        return;
      }
      socket.close();
    }
  }

  private scheduleRetry(target: ConnectionTarget): void {
    if (this.target !== target) return;
    const delay = this.backoffMs[Math.min(this.retry, this.backoffMs.length - 1)]!;
    this.retry += 1;
    this.publish({
      phase: this.gatewayRestarting ? 'gateway-restarting' : 'reconnecting',
      url: target.url,
    });
    this.retryTimer = setTimeout(() => this.dial(), delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  private disposeSocket(): void {
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.client?.close();
    this.client = undefined;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = undefined;
  }

  private publish(state: RpcState): void {
    this.state = state;
    this.deps.onState(state);
  }
}
