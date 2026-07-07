/**
 * Multi-client App Server entry for gateway deployments (app-server spec).
 * This exposes the generic `@enterprise-agent/agent-server` JSON-RPC protocol
 * over WebSocket while reusing the gateway's keychain and web session store.
 *
 * Two entry points (gateway-consolidation §P1):
 *   - `startGatewayAppRpc` — the injectable core. Attaches `/rpc` to an
 *     ALREADY-bootstrapped `AgentHost`, so the resident `ea-gateway start`
 *     can serve IM channels and `/rpc` on ONE shared host. Its `dispose` only
 *     closes the HTTP/WS server — the caller owns the host's lifecycle.
 *   - `startGatewayAppRpcServer` — the standalone `ea-gateway app-server`
 *     command wrapper: bootstraps its own host, delegates, and disposes both.
 */
import type { IncomingMessage } from 'node:http';
import {
  startNodeAppServer,
  type NodeAppServerHandle,
} from '@enterprise-agent/agent-server/node';
import type { AppServerAuth } from '@enterprise-agent/agent-server';
import type { AgentHost } from '@enterprise-agent/agent-contract';
import { bootstrapGateway } from '../host/bootstrap.js';
import { SessionStore } from '../accounts/session-store.js';
import { authenticate } from '../accounts/auth-http.js';
import { resolveAuthMode, isLoopbackPeer, type AuthMode } from '../accounts/auth-mode.js';

export interface GatewayAppRpcCoreOptions {
  /** The shared, already-bootstrapped agent host to attach `/rpc` to. */
  agentHost: AgentHost;
  /** Session store for cookie/bearer auth. Defaults to one over `identityDir`. */
  sessions: SessionStore;
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; put public deployments behind TLS. */
  host?: string;
  log?: (line: string) => void;
}

export interface GatewayAppRpcOptions {
  root?: string;
  port?: number;
  /** Bind address. Defaults to 127.0.0.1; put public deployments behind TLS. */
  host?: string;
  log?: (line: string) => void;
}

export interface GatewayAppRpcHandle extends NodeAppServerHandle {}

/**
 * Attach `/rpc` to an injected host. Does NOT bootstrap or dispose the host —
 * the caller (e.g. `runStart`) owns it. Used to share one `AgentHost` between
 * the IM channels and the RPC surface.
 */
export async function startGatewayAppRpc(opts: GatewayAppRpcCoreOptions): Promise<GatewayAppRpcHandle> {
  const { sessions } = opts;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  // open (loopback,免 key) / managed (强制 key)。由 bind host 推导，非 loopback 自动
  // managed，EA_GATEWAY_AUTH_MODE 可覆盖（gateway-consolidation §4.1 / §7-A）。
  const mode = resolveAuthMode(opts.host);
  log(`[app-server] 认证模式：${mode}${mode === 'open' ? '（loopback 免 key）' : '（需 access key）'}`);
  return startNodeAppServer({
    agentHost: opts.agentHost,
    host: opts.host,
    port: opts.port,
    rpcPath: '/rpc',
    log,
    authenticate: (req) => authenticateRpc(req, sessions, mode),
    originAllowed,
  });
}

/**
 * Standalone `ea-gateway app-server`: bootstraps its own host and disposes it on
 * shutdown. For the consolidated single-process deployment, prefer folding `/rpc`
 * into `ea-gateway start` via `startGatewayAppRpc` (gateway-consolidation §P1).
 */
export async function startGatewayAppRpcServer(opts: GatewayAppRpcOptions = {}): Promise<GatewayAppRpcHandle> {
  const ctx = bootstrapGateway(opts.root);
  const sessions = new SessionStore(ctx.paths.identityDir);
  const node = await startGatewayAppRpc({
    agentHost: ctx.host,
    sessions,
    host: opts.host,
    port: opts.port,
    log: opts.log,
  });

  return {
    ...node,
    dispose: async () => {
      await node.dispose();
      await ctx.dispose();
    },
  };
}

/**
 * Resolve a WebSocket-upgrade request to app-server auth (gateway-consolidation
 * §4.3). Order: session cookie → Bearer access key → (open mode only) loopback
 * trust. In `managed` mode a request without a valid cookie/key is rejected (401).
 */
export function authenticateRpc(
  req: IncomingMessage,
  sessions: SessionStore,
  mode: AuthMode,
): AppServerAuth | undefined {
  const cookieAccount = authenticate(req.headers.cookie, sessions);
  if (cookieAccount) return { accountId: cookieAccount };

  const bearer = bearerToken(req.headers.authorization);
  if (bearer) {
    const accountId = sessions.resolve(bearer);
    if (accountId) return { accountId };
  }

  // `open` posture: a loopback peer is trusted without a key (local dev). `managed`
  // never grants access on loopback alone — it always needs a cookie/key above.
  if (mode === 'open' && isLoopbackPeer(req.socket.remoteAddress)) {
    return { trusted: true };
  }

  return undefined;
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
