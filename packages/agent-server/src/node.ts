import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { createAppServer, type AppServer, type AppServerAuth, type AppServerConnection, type AppServerOptions } from './server.js';

/**
 * High-water mark for a socket's outbound buffer. `sendToSocket` stops resolving
 * once `ws.bufferedAmount` exceeds this, applying real backpressure so the
 * app-level `maxOutboundQueue` can fill and drop/close a stuck client. Without
 * this, `ws.send` returns instantly and the queue never fills — an unbounded
 * memory leak against a slow consumer.
 */
const OUTBOUND_HIGH_WATER_BYTES = 1024 * 1024;
/** Give up (and let the connection close) if a socket won't drain within this. */
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 25;

export interface NodeAppServerOptions extends Omit<AppServerOptions, 'host'> {
  agentHost: AppServerOptions['host'];
  /** Bind address. Defaults to 127.0.0.1; public deploys should sit behind TLS. */
  host?: string;
  /** TCP port. Defaults to 7320. */
  port?: number;
  /** WebSocket RPC path. Defaults to /rpc. */
  rpcPath?: string;
  /**
   * Resolve a WebSocket upgrade request into app-server auth. Return undefined
   * to reject with 401. Public deployments typically check Cookie or Bearer.
   */
  authenticate(req: IncomingMessage): AppServerAuth | undefined | Promise<AppServerAuth | undefined>;
  /** Optional origin gate. Return false to reject with 403. */
  originAllowed?: (req: IncomingMessage) => boolean;
  log?: (line: string) => void;
}

export interface NodeAppServerHandle {
  url: string;
  rpcUrl: string;
  server: Server;
  appServer: AppServer;
  dispose(): Promise<void>;
}

export async function startNodeAppServer(opts: NodeAppServerOptions): Promise<NodeAppServerHandle> {
  const bindHost = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7320;
  const rpcPath = opts.rpcPath ?? '/rpc';
  const log = opts.log ?? (() => {});
  const appServer = createAppServer({
    host: opts.agentHost,
    serverInfo: opts.serverInfo,
    access: opts.access,
  });
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => routeHttp(req, res));

  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head).catch(() => rejectUpgrade(socket, 500, 'internal server error'));
  });

  // Surface async listen failures (EADDRINUSE et al) as a rejection instead of
  // an uncaughtException — callers like `ea-gateway start` deliberately treat a
  // bind failure as non-fatal (the IM channels must keep serving).
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, bindHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const url = `http://${bindHost}:${port}`;
  log(`[app-server] listening on ${url}${rpcPath}`);

  return {
    url,
    rpcUrl: `ws://${bindHost}:${port}${rpcPath}`,
    server,
    appServer,
    dispose: async () => {
      // Force-drop live clients: `server.close` only waits for sockets to end,
      // so a connected client (e.g. the desktop app during a sidecar restart)
      // would otherwise wedge shutdown forever — the old process keeps holding
      // the port and the replacement dies with EADDRINUSE (desktop-app §4.3).
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      appServer.dispose();
    },
  };

  function routeHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'not found' }));
  }

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== rpcPath) {
      rejectUpgrade(socket, 404, 'not found');
      return;
    }
    if (opts.originAllowed && !opts.originAllowed(req)) {
      rejectUpgrade(socket, 403, 'forbidden');
      return;
    }
    const auth = await opts.authenticate(req);
    if (!auth) {
      rejectUpgrade(socket, 401, 'unauthorized');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = appServer.createConnection({
        auth,
        send: (message) => sendToSocket(ws, JSON.stringify(message)),
        close: () => ws.close(),
      });
      ws.on('message', (data) => void onMessage(conn, data));
      ws.on('close', () => conn.close());
      ws.on('error', () => conn.close());
    });
  }
}

async function onMessage(conn: AppServerConnection, data: RawData): Promise<void> {
  if (Array.isArray(data)) {
    await conn.receive(Buffer.concat(data).toString('utf8'));
    return;
  }
  await conn.receive(Buffer.isBuffer(data) ? data.toString('utf8') : data.toString());
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Write one frame and resolve only once the socket's outbound buffer is back
 * under the high-water mark. Rejecting (socket not OPEN, write error, or drain
 * timeout) propagates to the connection's `flush`, which closes it — so a
 * closing/stuck socket surfaces as a real failure instead of a silent drop.
 */
export function sendToSocket(ws: WebSocket, payload: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error('socket not open'));
      return;
    }
    ws.send(payload, (err) => (err ? reject(err) : resolve()));
  }).then(() => waitForDrain(ws));
}

function waitForDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount <= OUTBOUND_HIGH_WATER_BYTES) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        reject(new Error('socket closed while draining'));
      } else if (ws.bufferedAmount <= OUTBOUND_HIGH_WATER_BYTES) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > DRAIN_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error('outbound backpressure drain timeout'));
      }
    }, DRAIN_POLL_MS);
    timer.unref?.();
  });
}
