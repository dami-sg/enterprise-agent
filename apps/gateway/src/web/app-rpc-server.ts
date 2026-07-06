/**
 * Multi-client App Server entry for gateway deployments (app-server spec).
 * This exposes the generic `@enterprise-agent/agent-server` JSON-RPC protocol
 * over WebSocket while reusing the gateway's bootstrap, keychain, and web
 * session store. It is intentionally separate from `chat-server.ts`: the old
 * Web `/api/chat` SSE surface remains as a compatibility/product endpoint,
 * while `/rpc` is the shared protocol for Web, desktop, mobile, and IDE clients.
 */
import type { IncomingMessage } from 'node:http';
import {
  startNodeAppServer,
  type NodeAppServerHandle,
} from '@enterprise-agent/agent-server/node';
import type { AppServerAuth } from '@enterprise-agent/agent-server';
import { bootstrapGateway } from '../host/bootstrap.js';
import { SessionStore } from '../accounts/session-store.js';
import { authenticate } from '../accounts/auth-http.js';

export interface GatewayAppRpcOptions {
  root?: string;
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; put public deployments behind TLS. */
  host?: string;
  log?: (line: string) => void;
}

export interface GatewayAppRpcHandle extends NodeAppServerHandle {}

export async function startGatewayAppRpcServer(opts: GatewayAppRpcOptions = {}): Promise<GatewayAppRpcHandle> {
  const ctx = bootstrapGateway(opts.root);
  const sessions = new SessionStore(ctx.paths.identityDir);
  const node = await startNodeAppServer({
    agentHost: ctx.host,
    host: opts.host,
    port: opts.port,
    rpcPath: '/rpc',
    log: opts.log ?? ((line) => process.stderr.write(line + '\n')),
    authenticate: (req) => authenticateRpc(req, sessions),
    originAllowed,
  });

  return {
    ...node,
    dispose: async () => {
      await node.dispose();
      await ctx.dispose();
    },
  };
}

function authenticateRpc(req: IncomingMessage, sessions: SessionStore): AppServerAuth | undefined {
  const cookieAccount = authenticate(req.headers.cookie, sessions);
  if (cookieAccount) return { accountId: cookieAccount };

  const bearer = bearerToken(req.headers.authorization);
  if (bearer) {
    const accountId = sessions.resolve(bearer);
    if (accountId) return { accountId };
  }

  const trustedToken = process.env.EA_APP_SERVER_TRUSTED_TOKEN;
  const presented = req.headers['x-enterprise-agent-token'];
  if (
    trustedToken &&
    typeof presented === 'string' &&
    safeEqual(presented, trustedToken) &&
    isLoopback(req.socket.remoteAddress)
  ) {
    return { trusted: true };
  }

  return undefined;
}

/** Constant-time string compare so the trusted token isn't leaked by timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = (process.env.EA_WEB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length) {
    return allowed.some((a) => {
      try {
        return new URL(a).host === originHost;
      } catch {
        return a === originHost;
      }
    });
  }
  return req.headers.host !== undefined && originHost === req.headers.host;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
