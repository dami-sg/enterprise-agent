/**
 * Standalone Web chat server (web-app §4 / §6). The PUBLIC-facing tier — kept
 * separate from the localhost admin panel ([server.ts]) so the two have distinct
 * auth domains (web-app §6): the admin panel stays localhost+Host-header gated,
 * while this server authenticates every request by the session cookie.
 *
 * Mounts the three account-scoped endpoints (chat stream / sessions / history)
 * over the same in-process `AgentHost` the IM channels use, so a Web turn and a
 * Telegram turn for the same account share memory (cross-channel-memory §3).
 *
 * Binds 127.0.0.1 by default; a real public deploy fronts it with TLS + sets a
 * wider bind host (W6 hardening). Auth/login endpoints (OAuth) are W1c; until
 * then mint a dev session with `ea-gateway account login <accountId>`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bootstrapGateway } from '../host/bootstrap.js';
import { Router } from '../runtime/router.js';
import { SessionStore } from '../accounts/session-store.js';
import { ReplayCache } from '../accounts/replay-cache.js';
import { ConfigStore, createPaths } from '@enterprise-agent/agent';
import { IdentityStore } from '../accounts/identity-store.js';
import { loadGatewayConfig, resolveToken } from '../config/gateway-config.js';
import {
  handleChatRequest,
  handleDeleteRequest,
  handleHistoryRequest,
  handleModeRequest,
  handleModelsRequest,
  handleRenameRequest,
  handleRespondRequest,
  handleSessionsRequest,
  type WebChatDeps,
} from './chat-endpoint.js';
import { PendingResponses } from './pending.js';
import {
  handleAuthConfig,
  handleGoogleMockAuth,
  handleLogout,
  handleMe,
  handleTelegramAuth,
  type AuthDeps,
} from './auth-endpoint.js';
import { matchWebRoute } from './chat-routes.js';

export interface WebChatOptions {
  root?: string;
  port?: number;
  /** Bind address — defaults to 127.0.0.1. Public deploy sets this + TLS front. */
  host?: string;
  /** Base dir for per-account workspace isolation (§4.3). */
  workspaceBase?: string;
  log?: (line: string) => void;
}

export interface WebChatHandle {
  url: string;
  server: Server;
  dispose(): Promise<void>;
}

export async function startWebChat(opts: WebChatOptions = {}): Promise<WebChatHandle> {
  const log = opts.log ?? ((l) => process.stderr.write(l + '\n'));
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7318;

  const ctx = bootstrapGateway(opts.root);
  const config = new ConfigStore(createPaths(opts.root));
  const sessions = new SessionStore(ctx.paths.identityDir);
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const deps: WebChatDeps = {
    host: ctx.host,
    router: new Router(ctx.paths.routes),
    sessions,
    workspaceBase: opts.workspaceBase,
    listModels: () => config.effective(undefined, []).aliases.map((a) => ({ alias: a.alias, ref: a.ref })),
    pending: new PendingResponses(),
  };

  // Auth (W1c): real Telegram (verify the channel bot token) + dev Google mock.
  let telegramBotToken: string | undefined;
  try {
    const gw = loadGatewayConfig(ctx.paths.gatewayConfig);
    const tg = gw.channels.find((c) => c.name === 'telegram');
    if (tg) telegramBotToken = resolveToken(tg, ctx.keychain);
  } catch {
    telegramBotToken = undefined; // no telegram channel / token → Telegram login 503s
  }
  // The dev Google mock mints a session for ANY email with no credential check,
  // so it must be an explicit opt-in — NEVER inferred from the bind address (a
  // reverse-proxy → loopback upstream would otherwise expose credential-free login
  // publicly). Warn loudly if it's on while bound non-loopback.
  const devAuth = process.env.EA_WEB_DEV_AUTH === '1';
  if (devAuth && !isLoopback) {
    log('[gateway] ⚠️  EA_WEB_DEV_AUTH is ON while bound to a non-loopback host — anyone can log in as any account. Disable it for public deployments.');
  }
  const authDeps: AuthDeps = {
    identities: new IdentityStore(ctx.paths.identityDir),
    sessions,
    telegramClientId: process.env.EA_TELEGRAM_CLIENT_ID,
    telegramBotToken,
    telegramBotUsername: process.env.EA_TELEGRAM_BOT_USERNAME,
    devAuth,
    secure: !isLoopback,
    replay: new ReplayCache(),
  };

  const server = createServer((req, res) => {
    void dispatch(req, res, deps, authDeps).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  log(`[gateway] Web 聊天端已启动：${url}`);

  return {
    url,
    server,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.dispose();
    },
  };
}

/**
 * CSRF defense (web-app §6): the cookie alone authenticates every request, so a
 * state-changing request must also prove it came from an allowed origin. Browsers
 * always attach `Origin` on cross-site POST/DELETE, so a forged request from
 * attacker.com is rejected; same-origin requests match the `Host`. Behind a TLS
 * front (where the proxy may rewrite `Host`), set `EA_WEB_ALLOWED_ORIGINS` to the
 * public origin(s). A request with no `Origin` (a non-browser API client) is
 * allowed — those can't be driven by a victim's browser.
 */
export function originOk(req: IncomingMessage): boolean {
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

async function dispatch(req: IncomingMessage, res: ServerResponse, deps: WebChatDeps, auth: AuthDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  // Reject cross-origin state-changing requests before any handler runs.
  if (method !== 'GET' && method !== 'HEAD' && !originOk(req)) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'forbidden: bad origin' }));
    return;
  }
  const m = matchWebRoute(method, url.pathname);
  switch (m.route) {
    case 'chat':
      return handleChatRequest(req, res, deps);
    case 'respond':
      return handleRespondRequest(req, res, deps);
    case 'sessions':
      return handleSessionsRequest(req, res, deps);
    case 'models':
      return handleModelsRequest(req, res, deps);
    case 'history':
      return handleHistoryRequest(req, res, deps, m.sessionId);
    case 'rename':
      return handleRenameRequest(req, res, deps, m.sessionId);
    case 'mode':
      return handleModeRequest(req, res, deps, m.sessionId);
    case 'delete':
      return handleDeleteRequest(req, res, deps, m.sessionId);
    case 'auth-telegram':
      return handleTelegramAuth(req, res, auth);
    case 'auth-google-mock':
      return handleGoogleMockAuth(req, res, auth);
    case 'auth-logout':
      return void handleLogout(req, res, auth);
    case 'auth-me':
      return void handleMe(req, res, auth);
    case 'auth-config':
      return void handleAuthConfig(req, res, auth);
    case 'method-not-allowed':
      res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'method not allowed' }));
      return;
    case 'not-found':
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
  }
}
