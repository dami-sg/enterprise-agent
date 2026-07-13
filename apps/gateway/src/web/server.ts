/**
 * Local Web config panel (gateway §7). A zero-dependency Node `http` server that
 * binds to localhost only and exposes a small JSON API over `GatewayAdmin`, plus
 * the single-page UI. It is the visual "configure from zero" surface: providers
 * + models (the core), channels, secrets, and WeChat QR login — writing exactly
 * the same on-disk truth the CLI does. Run `ea-gateway start` afterwards.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { ConfigStore, createPaths } from '@dami-sg/agent';
import { bootstrapGateway, type GatewayContext } from '../host/bootstrap.js';
import { GatewayAdmin } from './admin.js';
import { APP_HTML } from './app-html.js';
import {
  loadOrCreateAdminSecret,
  verifyAdminSecret,
  verifyAdminCookie,
  adminSetCookie,
  adminClearCookie,
} from '../accounts/admin-auth.js';
import { hostHeaderAllowed } from '../accounts/auth-mode.js';

export interface WebUiOptions {
  root?: string;
  port?: number;
  /** Bind address — defaults to 127.0.0.1 (never expose the panel publicly). */
  host?: string;
  /**
   * Auto-spawn the resident data-plane gateway on panel boot if it isn't already
   * running (gateway-consolidation §P2), so the operator launches only the panel.
   * Defaults to true; `ea-gateway ui --no-autostart` opts out.
   */
  autostart?: boolean;
  /**
   * Gate the panel behind an admin login secret (gateway-consolidation §P3c).
   * Defaults to true (the panel is a resident control plane). `false` — via
   * `ea-gateway ui --no-auth` — leaves it Host/Origin-gated only, for pure local dev.
   */
  auth?: boolean;
  log?: (line: string) => void;
}

export interface WebUiHandle {
  url: string;
  server: Server;
  dispose(): Promise<void>;
}

export async function startWebUI(opts: WebUiOptions = {}): Promise<WebUiHandle> {
  const log = opts.log ?? ((l) => process.stderr.write(l + '\n'));
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7317;

  const ctx: GatewayContext = bootstrapGateway(opts.root);
  const config = new ConfigStore(createPaths(opts.root));
  const admin = new GatewayAdmin({ config, keychain: ctx.keychain, host: ctx.host, paths: ctx.paths });

  // Admin login secret (§P3c). Shared 0600 file; whoever creates it prints it once.
  // `--no-auth` leaves the panel Host/Origin-gated only (pure local dev).
  let secret: string | undefined;
  if (opts.auth !== false) {
    const s = loadOrCreateAdminSecret(ctx.paths.adminSecret);
    secret = s.secret;
    if (s.created) log(`[gateway] 🔑 管理面登录秘钥（首次生成，请妥善保存）：${s.secret}`);
    else log(`[gateway] 管理面登录已启用（秘钥文件：${ctx.paths.adminSecret}）。`);
  }

  // Bring the data plane up automatically so "launch the panel" is all the
  // operator does (gateway-consolidation §P2). The spawned `ea-gateway start`
  // opens /rpc on its own shared host; no-op if one is already running.
  if (opts.autostart !== false) {
    try {
      const st = admin.gatewayStatus();
      if (st.state === 'running') {
        log(`[gateway] 数据面已在运行（PID ${st.pid}）。`);
      } else {
        const started = admin.startGateway();
        log(`[gateway] 已自动拉起数据面（PID ${started.pid ?? '?'}）。`);
      }
    } catch (err) {
      log(`[gateway] 数据面自动拉起失败：${(err as Error).message}（可在面板手动启动）`);
    }
  }

  const server = createServer((req, res) => {
    // The panel reads/writes provider keys and config over unauthenticated
    // localhost endpoints. Reject any request whose Host header isn't the local
    // bind target so a page the operator visits can't reach it via DNS rebinding
    // (resolve attacker.com → 127.0.0.1) and drive these POSTs cross-origin.
    if (!hostHeaderAllowed(req.headers.host, host, port)) {
      return sendJson(res, 403, { error: 'forbidden: unexpected Host header' });
    }
    void route(admin, secret, req, res).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${port}`;
  log(`[gateway] 配置面板已启动：${url}`);

  return {
    url,
    server,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.dispose();
    },
  };
}

async function route(
  admin: GatewayAdmin,
  secret: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const q = url.searchParams;

  // -- UI shell (unauthenticated: it renders the login overlay when needed) --
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP_HTML);
    return;
  }

  // -- admin login (§P3c), before the auth gate --
  if (path === '/api/admin/me' && method === 'GET') {
    return sendJson(res, 200, {
      authed: !secret || verifyAdminCookie(req.headers.cookie, secret),
      required: !!secret,
    });
  }
  if (path === '/api/admin/login' && method === 'POST') {
    if (!originAllowed(req)) return sendJson(res, 403, { error: 'forbidden: bad origin' });
    if (!secret) return sendJson(res, 200, { ok: true }); // auth disabled
    const body = (await readBody(req)) as { secret?: string };
    if (!verifyAdminSecret(body.secret, secret)) return sendJson(res, 401, { error: 'invalid secret' });
    res
      .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': adminSetCookie(secret) })
      .end(JSON.stringify({ ok: true }));
    return;
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    if (!originAllowed(req)) return sendJson(res, 403, { error: 'forbidden: bad origin' });
    res
      .writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': adminClearCookie() })
      .end(JSON.stringify({ ok: true }));
    return;
  }

  // -- auth gate: every other /api/* needs a valid admin session (§P3c) --
  if (secret && !verifyAdminCookie(req.headers.cookie, secret)) {
    return sendJson(res, 401, { error: 'unauthorized: admin login required' });
  }

  // -- read-only GET API --
  if (method === 'GET') {
    switch (path) {
      case '/api/state':
        return sendJson(res, 200, admin.state());
      case '/api/modalities':
        return sendJson(res, 200, await admin.modelModalities());
      case '/api/gateway/status':
        return sendJson(res, 200, admin.gatewayStatus());
      case '/api/accounts':
        return sendJson(res, 200, admin.listAccounts());
      case '/api/models':
        return sendJson(res, 200, await admin.discoverModels(must(q.get('id'), 'id'), q.get('refresh') === '1'));
      case '/api/usage':
        return sendJson(res, 200, await admin.usage({
          by: q.get('by') ?? undefined,
          from: q.get('from') ?? undefined,
          to: q.get('to') ?? undefined,
          category: q.get('category') ?? undefined,
          model: q.get('model') ?? undefined,
        }));
      case '/api/secret':
        return sendJson(res, 200, { present: admin.checkSecret(must(q.get('ref'), 'ref')) });
      case '/api/weixin/login/status':
        return sendJson(res, 200, await admin.pollWeixinLogin(must(q.get('loginId'), 'loginId')));
      case '/api/skill/get':
        return sendJson(res, 200, admin.getSkill(must(q.get('dir'), 'dir')));
      case '/api/agent/get':
        return sendJson(res, 200, admin.getAgent(must(q.get('dir'), 'dir')));
      case '/api/schedule/get':
        return sendJson(res, 200, admin.getSchedule(must(q.get('dir'), 'dir')));
    }
    return sendJson(res, 404, { error: `not found: ${path}` });
  }

  // -- mutating POST API --
  if (method === 'POST') {
    // CSRF: a local page the operator visits can still reach 127.0.0.1 with a
    // passing Host header, so also require a same-origin `Origin` on mutations
    // (the panel's own fetches send it; a cross-site page's would mismatch). A
    // request with no Origin (curl / non-browser) is allowed.
    if (!originAllowed(req)) {
      return sendJson(res, 403, { error: 'forbidden: bad origin' });
    }
    const body = await readBody(req);
    switch (path) {
      case '/api/provider':
        admin.addProvider(body as { kind: string; id: string; baseURL?: string; key?: string });
        return sendJson(res, 200, { ok: true });
      case '/api/provider/delete':
        admin.deleteProvider((body as { id: string }).id);
        return sendJson(res, 200, { ok: true });
      case '/api/model':
        admin.setOrchestrator((body as { ref: string }).ref);
        return sendJson(res, 200, { ok: true });
      case '/api/secret':
        admin.setSecret((body as { ref: string }).ref, (body as { value: string }).value);
        return sendJson(res, 200, { ok: true });
      case '/api/secret/delete':
        admin.deleteSecret((body as { ref: string }).ref);
        return sendJson(res, 200, { ok: true });
      case '/api/channel':
        admin.upsertChannel(body as never);
        return sendJson(res, 200, { ok: true });
      case '/api/channel/delete':
        admin.deleteChannel((body as { name: string }).name, (body as { accountId?: string }).accountId);
        return sendJson(res, 200, { ok: true });
      case '/api/channel/enable':
        admin.setChannelEnabled(
          (body as { name: string }).name,
          (body as { accountId?: string }).accountId,
          (body as { enabled: boolean }).enabled,
        );
        return sendJson(res, 200, { ok: true });
      case '/api/channel/update':
        admin.updateChannelPolicy(
          (body as { name: string }).name,
          (body as { accountId?: string }).accountId,
          {
            executionMode: (body as { executionMode?: string }).executionMode,
            approval: (body as { approval?: string }).approval,
          },
        );
        return sendJson(res, 200, { ok: true });
      case '/api/verbose':
        admin.setVerbose((body as { verbose: boolean }).verbose);
        return sendJson(res, 200, { ok: true });
      case '/api/stt':
        admin.setStt(body as never);
        return sendJson(res, 200, { ok: true });
      case '/api/stt/delete':
        admin.deleteStt((body as { id: string }).id);
        return sendJson(res, 200, { ok: true });
      case '/api/stt/active':
        admin.setSttActive((body as { id: string }).id);
        return sendJson(res, 200, { ok: true });
      case '/api/media':
        admin.setMedia(body as never);
        return sendJson(res, 200, { ok: true });
      case '/api/gateway/start':
        return sendJson(res, 200, admin.startGateway());
      case '/api/gateway/stop':
        return sendJson(res, 200, admin.stopGateway());
      case '/api/gateway/restart':
        return sendJson(res, 200, admin.restartGateway());
      case '/api/mcp':
        admin.saveMcp(body as never);
        return sendJson(res, 200, { ok: true });
      case '/api/mcp/delete':
        admin.deleteMcp((body as { name: string }).name);
        return sendJson(res, 200, { ok: true });
      case '/api/mcp/enable':
        admin.setMcpEnabled((body as { name: string }).name, (body as { enabled: boolean }).enabled);
        return sendJson(res, 200, { ok: true });
      case '/api/skill':
        return sendJson(res, 200, admin.saveSkillFile((body as { content: string }).content, (body as { dir?: string }).dir));
      case '/api/skill/zip':
        return sendJson(res, 200, admin.addSkillZip((body as { zip: string }).zip));
      case '/api/skill/bundled/install':
        return sendJson(res, 200, admin.installBundledSkill((body as { dir: string }).dir));
      case '/api/skill/enable':
        admin.setSkillEnabled((body as { dir: string }).dir, (body as { enabled: boolean }).enabled);
        return sendJson(res, 200, { ok: true });
      case '/api/skill/delete':
        admin.deleteSkill((body as { dir: string }).dir);
        return sendJson(res, 200, { ok: true });
      case '/api/agent':
        return sendJson(res, 200, admin.saveAgentFile((body as { content: string }).content, (body as { dir?: string }).dir));
      case '/api/agent/zip':
        return sendJson(res, 200, admin.addAgentZip((body as { zip: string }).zip));
      case '/api/agent/bundled/install':
        return sendJson(res, 200, admin.installBundledAgent((body as { dir: string }).dir));
      case '/api/agent/enable':
        admin.setAgentEnabled((body as { dir: string }).dir, (body as { enabled: boolean }).enabled);
        return sendJson(res, 200, { ok: true });
      case '/api/agent/delete':
        admin.deleteAgent((body as { dir: string }).dir);
        return sendJson(res, 200, { ok: true });
      case '/api/schedule':
        return sendJson(res, 200, admin.saveScheduleFile((body as { content: string }).content, (body as { dir?: string }).dir));
      case '/api/schedule/enable':
        admin.setScheduleEnabled((body as { dir: string }).dir, (body as { enabled: boolean }).enabled);
        return sendJson(res, 200, { ok: true });
      case '/api/schedule/delete':
        admin.deleteSchedule((body as { dir: string }).dir);
        return sendJson(res, 200, { ok: true });
      case '/api/schedule/run':
        return sendJson(res, 200, await admin.runScheduleNow((body as { name: string }).name));
      case '/api/route/delete':
        admin.deleteRoute((body as { channel: string }).channel, (body as { conversationId: string }).conversationId);
        return sendJson(res, 200, { ok: true });
      case '/api/account/create':
        return sendJson(res, 200, admin.createAccount((body as { name?: string }).name));
      case '/api/account/key/issue':
        return sendJson(res, 200, admin.issueAccessKey((body as { accountId: string }).accountId, (body as { ttlDays?: number }).ttlDays));
      case '/api/account/key/revoke':
        return sendJson(res, 200, admin.revokeAccessKeys((body as { accountId: string }).accountId));
      case '/api/identity/unbind':
        return sendJson(res, 200, admin.unbindIdentity((body as { provider: string }).provider, (body as { providerUserId: string }).providerUserId));
      case '/api/weixin/login/start':
        return sendJson(res, 200, await admin.startWeixinLogin(body as { baseURL?: string; accountId?: string }));
    }
    return sendJson(res, 404, { error: `not found: ${path}` });
  }

  sendJson(res, 405, { error: `method not allowed: ${method}` });
}

/**
 * Same-origin check for mutations: the request's `Origin` (if the browser sent
 * one) must match its `Host`. Defeats a cross-site page driving the panel's POSTs
 * even when the Host-header guard passes (the page targets literal 127.0.0.1). No
 * `Origin` (non-browser client) is allowed. The Host-header allowlist that defeats
 * DNS-rebinding lives in `hostHeaderAllowed` (../accounts/auth-mode.js).
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function must(v: string | null, name: string): string {
  if (v == null) throw new Error(`缺少参数：${name}`);
  return v;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      // Headroom for a base64-encoded skill zip (a normal JSON body is tiny).
      // Tear the socket down on overflow rather than buffering past the cap.
      if (data.length > 32_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`无效 JSON：${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}
