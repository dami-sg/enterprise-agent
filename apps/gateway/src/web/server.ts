/**
 * Local Web config panel (gateway §7). A zero-dependency Node `http` server that
 * binds to localhost only and exposes a small JSON API over `GatewayAdmin`, plus
 * the single-page UI. It is the visual "configure from zero" surface: providers
 * + models (the core), channels, secrets, and WeChat QR login — writing exactly
 * the same on-disk truth the CLI does. Run `ea-gateway start` afterwards.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { ConfigStore, createPaths } from '@enterprise-agent/agent';
import { bootstrapGateway, type GatewayContext } from '../host/bootstrap.js';
import { GatewayAdmin } from './admin.js';
import { APP_HTML } from './app-html.js';

export interface WebUiOptions {
  root?: string;
  port?: number;
  /** Bind address — defaults to 127.0.0.1 (never expose the panel publicly). */
  host?: string;
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

  const server = createServer((req, res) => {
    void route(admin, req, res).catch((err) => sendJson(res, 500, { error: (err as Error).message }));
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

async function route(admin: GatewayAdmin, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const q = url.searchParams;

  // -- UI --
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP_HTML);
    return;
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
      case '/api/models':
        return sendJson(res, 200, await admin.discoverModels(must(q.get('id'), 'id'), q.get('refresh') === '1'));
      case '/api/secret':
        return sendJson(res, 200, { present: admin.checkSecret(must(q.get('ref'), 'ref')) });
      case '/api/weixin/login/status':
        return sendJson(res, 200, await admin.pollWeixinLogin(must(q.get('loginId'), 'loginId')));
      case '/api/skill/get':
        return sendJson(res, 200, admin.getSkill(must(q.get('dir'), 'dir')));
    }
    return sendJson(res, 404, { error: `not found: ${path}` });
  }

  // -- mutating POST API --
  if (method === 'POST') {
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
      case '/api/skill/enable':
        admin.setSkillEnabled((body as { dir: string }).dir, (body as { enabled: boolean }).enabled);
        return sendJson(res, 200, { ok: true });
      case '/api/skill/delete':
        admin.deleteSkill((body as { dir: string }).dir);
        return sendJson(res, 200, { ok: true });
      case '/api/route/delete':
        admin.deleteRoute((body as { channel: string }).channel, (body as { conversationId: string }).conversationId);
        return sendJson(res, 200, { ok: true });
      case '/api/weixin/login/start':
        return sendJson(res, 200, await admin.startWeixinLogin(body as { baseURL?: string; accountId?: string }));
    }
    return sendJson(res, 404, { error: `not found: ${path}` });
  }

  sendJson(res, 405, { error: `method not allowed: ${method}` });
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
      if (data.length > 32_000_000) reject(new Error('请求体过大'));
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
