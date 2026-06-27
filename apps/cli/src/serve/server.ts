/**
 * `ea serve` HTTP+SSE server (cli §8 daemon 模式). The same `createAgentHost()`
 * the TUI embeds (cli §1), with one transport layer wrapped around it: commands
 * over HTTP (request style), events over SSE (`host.onEvent` fan-out). The shape
 * is isomorphic to the agent §6 contract (附录 A.2) — desktop apps spawn this as
 * a sidecar (`spawn('ea', ['serve'])`) and drive the host over the wire instead
 * of in-process.
 *
 * Security: this is a LOCAL surface that can approve tools and resolve secrets
 * via the host (agent §4). Three guards, all on this process:
 *   1. binds to loopback (127.0.0.1) by default — never public;
 *   2. rejects unexpected `Host` headers (defeats DNS-rebinding, same as the
 *      gateway web panel);
 *   3. requires a bearer token on every route incl. SSE.
 * The token is minted at boot and handed to the parent over the stdout handshake
 * (see commands/serve.ts), so a sibling process on the box can't drive it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AgentHost } from '@enterprise-agent/agent-contract';
import { handleApi } from './routes.js';
import { attachSse } from './sse.js';
import { sendError, sendJson } from './util.js';

export interface ServeOptions {
  /** The in-process host this server fronts (constructed by the caller). */
  host: AgentHost;
  /** TCP port; defaults to 4096 (cli §8.1). */
  port?: number;
  /** Bind address; defaults to 127.0.0.1 — never expose the sidecar publicly. */
  bindHost?: string;
  /** Bearer token clients must present; a random one is minted when omitted. */
  token?: string;
  log?: (line: string) => void;
}

export interface ServeHandle {
  url: string;
  token: string;
  port: number;
  server: Server;
  /** Stop accepting connections and close the server (does NOT dispose the host). */
  close(): Promise<void>;
}

export async function startServeServer(opts: ServeOptions): Promise<ServeHandle> {
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const requestedPort = opts.port ?? 4096;
  const token = opts.token ?? randomBytes(24).toString('hex');
  const log = opts.log ?? ((l) => process.stderr.write(l + '\n'));

  // The Host-header guard compares against the ACTUAL bound port; capture it once
  // the server is listening (relevant when port 0 asks the OS for an ephemeral one).
  let port = requestedPort;
  const server = createServer((req, res) => {
    void dispatch(opts.host, token, bindHost, port, req, res).catch((err) =>
      sendError(res, 500, (err as Error).message),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, bindHost, () => {
      server.off('error', reject);
      const addr = server.address();
      if (addr && typeof addr === 'object') port = addr.port;
      resolve();
    });
  });

  const url = `http://${bindHost}:${port}`;
  log(`[serve] sidecar 已启动：${url}`);

  return {
    url,
    token,
    port,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function dispatch(
  host: AgentHost,
  token: string,
  bindHost: string,
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  // Reject DNS-rebinding before anything else (a page the user visits can't
  // resolve attacker.com → 127.0.0.1 and POST to this host cross-origin).
  if (!hostHeaderAllowed(req, bindHost, port)) {
    return sendError(res, 403, 'forbidden: unexpected Host header');
  }

  // Liveness probe — unauthenticated on purpose so a parent can poll readiness
  // before it has parsed the token. Leaks nothing but pid/version.
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, pid: process.pid, version: '0.0.4' });
  }

  if (!bearerOk(req, url, token)) {
    return sendError(res, 401, 'unauthorized');
  }

  // Event stream: long-lived, fan-out of host.onEvent. Tear down on close.
  if (req.method === 'GET' && url.pathname === '/events') {
    const teardown = attachSse(host, res);
    req.on('close', teardown);
    return;
  }

  await handleApi(host, req, res, url);
}

/** Accept `Authorization: Bearer <token>` or `?token=<token>` (for EventSource,
 *  which can't set request headers). Constant-time-ish compare via length+scan. */
function bearerOk(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : (url.searchParams.get('token') ?? '');
  return safeEqual(presented, token);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Allow only requests addressed to the local bind target (loopback or the
 *  configured bind host) — defeats DNS-rebinding against this localhost server. */
function hostHeaderAllowed(req: IncomingMessage, bindHost: string, port: number): boolean {
  const raw = req.headers.host;
  if (!raw) return false;
  const hostname = raw.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return raw.toLowerCase() === `${bindHost}:${port}` || hostname === bindHost.toLowerCase();
}
