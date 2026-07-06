import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData } from 'ws';
import { createAppServer, type AppServer, type AppServerAuth, type AppServerConnection, type AppServerOptions } from './server.js';

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

  await new Promise<void>((resolve) => server.listen(port, bindHost, resolve));
  const url = `http://${bindHost}:${port}`;
  log(`[app-server] listening on ${url}${rpcPath}`);

  return {
    url,
    rpcUrl: `ws://${bindHost}:${port}${rpcPath}`,
    server,
    appServer,
    dispose: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
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
        send: (message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
        },
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
