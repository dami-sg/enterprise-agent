/**
 * Browser automation over MCP (desktop-app §browser). The desktop main process
 * hosts TWO loopback MCP servers — a `readonly` one (navigate-free reads: read
 * page, screenshot, list tabs) that the agent runs unprompted, and a `write` one
 * (navigate / click / type / …) that is approval-gated by riskTier — and writes
 * their configs into `<root>/mcp/` so the local gateway's `McpHub` auto-connects
 * (packages/agent/src/mcp/client.ts allows loopback http). Zero agent changes.
 *
 * Stateful streamable-HTTP transport: one transport per MCP session, keyed by the
 * `mcp-session-id` header the SDK issues on `initialize`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { BrowserManager } from './browser.js';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (b: BrowserManager, args: Record<string, unknown>) => Promise<Content[]>;
}

const text = (s: string): Content[] => [{ type: 'text', text: s }];
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
});
const P_STR = { type: 'string' };
const P_NUM = { type: 'number' };
const P_TAB = { tabId: { type: 'string', description: 'Target tab id; omit for the active tab.' } };

const READ_TOOLS: Tool[] = [
  { name: 'list_tabs', description: 'List all open browser tabs.', inputSchema: obj({}), run: async (b) => text(JSON.stringify(b.listTabs(), null, 2)) },
  { name: 'get_active_tab', description: 'The currently active tab (id, url, title).', inputSchema: obj({}), run: async (b) => text(JSON.stringify(b.getActiveTab() ?? 'no active tab')) },
  {
    name: 'read_page',
    description: 'Read the page as an accessibility-style list with [ref_N] handles on interactive elements. Call before click/type; the refs feed those tools.',
    inputSchema: obj({ ...P_TAB, maxChars: P_NUM }),
    run: async (b, a) => text(await b.readPage(str(a.tabId), num(a.maxChars) ?? 20000)),
  },
  { name: 'get_page_text', description: "The page's visible text (article-first).", inputSchema: obj({ ...P_TAB, maxChars: P_NUM }), run: async (b, a) => text(await b.pageText(str(a.tabId), num(a.maxChars) ?? 20000)) },
  { name: 'find', description: 'Find interactive elements by text; returns matching [ref_N]s from the last read_page.', inputSchema: obj({ ...P_TAB, query: P_STR }, ['query']), run: async (b, a) => text(await b.find(str(a.tabId), str(a.query) ?? '')) },
  {
    name: 'screenshot',
    description: 'Screenshot the tab (PNG).',
    inputSchema: obj({ ...P_TAB }),
    run: async (b, a) => {
      const png = await b.screenshot(str(a.tabId));
      return png
        ? [{ type: 'image', data: png, mimeType: 'image/png' }]
        : text('screenshot unavailable — no matching tab, or the page has not rendered yet (try again)');
    },
  },
];

const WRITE_TOOLS: Tool[] = [
  { name: 'navigate', description: 'Navigate a tab to a URL.', inputSchema: obj({ ...P_TAB, url: P_STR }, ['url']), run: async (b, a) => { b.navigate(str(a.tabId), str(a.url) ?? ''); return text(`navigating to ${str(a.url)}`); } },
  { name: 'new_tab', description: 'Open a new tab (optional url).', inputSchema: obj({ url: P_STR }), run: async (b, a) => text(`opened tab ${b.newTab(str(a.url))}`) },
  { name: 'close_tab', description: 'Close a tab.', inputSchema: obj({ tabId: P_STR }, ['tabId']), run: async (b, a) => { b.closeTab(str(a.tabId) ?? ''); return text('closed'); } },
  { name: 'select_tab', description: 'Switch to a tab.', inputSchema: obj({ tabId: P_STR }, ['tabId']), run: async (b, a) => { b.selectTab(str(a.tabId) ?? ''); return text('selected'); } },
  { name: 'go_back', description: 'History back.', inputSchema: obj({ ...P_TAB }), run: async (b, a) => { b.goBack(str(a.tabId)); return text('ok'); } },
  { name: 'go_forward', description: 'History forward.', inputSchema: obj({ ...P_TAB }), run: async (b, a) => { b.goForward(str(a.tabId)); return text('ok'); } },
  { name: 'reload', description: 'Reload the tab.', inputSchema: obj({ ...P_TAB }), run: async (b, a) => { b.reload(str(a.tabId)); return text('ok'); } },
  { name: 'click', description: 'Click an element by its [ref_N] from read_page.', inputSchema: obj({ ...P_TAB, ref: P_NUM }, ['ref']), run: async (b, a) => text((await b.click(str(a.tabId), num(a.ref) ?? -1)) ? 'clicked' : 'ref not found — call read_page again') },
  { name: 'type', description: 'Type text (optionally into a [ref_N] first); set submit to press Enter.', inputSchema: obj({ ...P_TAB, ref: P_NUM, text: P_STR, submit: { type: 'boolean' } }, ['text']), run: async (b, a) => text((await b.type(str(a.tabId), num(a.ref), str(a.text) ?? '', a.submit === true)) ? 'typed' : 'failed — read_page and use a valid ref') },
  { name: 'key', description: 'Press a key (e.g. Enter, Escape, ArrowDown).', inputSchema: obj({ ...P_TAB, key: P_STR }, ['key']), run: async (b, a) => { await b.key(str(a.tabId), str(a.key) ?? ''); return text('ok'); } },
  { name: 'scroll', description: 'Scroll the page up or down.', inputSchema: obj({ ...P_TAB, direction: { type: 'string', enum: ['up', 'down'] }, amount: P_NUM }, ['direction']), run: async (b, a) => { await b.scroll(str(a.tabId), a.direction === 'up' ? 'up' : 'down', num(a.amount) ?? 500); return text('ok'); } },
  { name: 'select_option', description: 'Set a <select> [ref_N] to a value.', inputSchema: obj({ ...P_TAB, ref: P_NUM, value: P_STR }, ['ref', 'value']), run: async (b, a) => text((await b.selectOption(str(a.tabId), num(a.ref) ?? -1, str(a.value) ?? '')) ? 'selected' : 'ref not found') },
];

function buildServer(name: string, tools: Tool[], browser: BrowserManager): Server {
  const server = new Server({ name, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: text(`unknown tool: ${req.params.name}`), isError: true };
    try {
      return { content: await tool.run(browser, (req.params.arguments ?? {}) as Record<string, unknown>) };
    } catch (e) {
      return { content: text(`error: ${(e as Error).message}`), isError: true };
    }
  });
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** A loopback streamable-HTTP MCP server for one tool set; resolves its port.
 *  `secret` gates every request: loopback binding alone doesn't authenticate —
 *  any local process (or a DNS-rebound page) could otherwise drive the
 *  logged-in browser session. The gateway reads the bearer from the config. */
function listen(
  name: string,
  tools: Tool[],
  browser: BrowserManager,
  secret: string,
): Promise<{ http: HttpServer; port: number }> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const http = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${secret}`) {
        res.writeHead(401).end();
        return;
      }
      const hdr = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(hdr) ? hdr[0] : hdr;
      if (req.method === 'POST') {
        const body = await readJson(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport && isInitializeRequest(body)) {
          const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, t);
            },
          });
          t.onclose = () => {
            if (t.sessionId) transports.delete(t.sessionId);
          };
          await buildServer(name, tools, browser).connect(t);
          transport = t;
        }
        if (!transport) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null }));
          return;
        }
        await transport.handleRequest(req, res, body);
      } else if ((req.method === 'GET' || req.method === 'DELETE') && sessionId && transports.get(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res);
      } else {
        res.writeHead(400).end();
      }
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      const addr = http.address();
      const port = addr && typeof addr !== 'string' ? addr.port : 0;
      resolve({ http, port });
    });
  });
}

export interface BrowserMcpDeps {
  browser: BrowserManager;
  /** Resolves the active profile's `<root>/mcp` dir where configs are written. */
  mcpDir: () => string;
}

export class BrowserMcpServer {
  private read?: { http: HttpServer; port: number };
  private write?: { http: HttpServer; port: number };
  /** Per-app-run bearer gating both loopback servers (rotates on restart). */
  private readonly secret = randomUUID();

  constructor(private readonly deps: BrowserMcpDeps) {}

  async start(): Promise<void> {
    this.read = await listen('desktop-browser', READ_TOOLS, this.deps.browser, this.secret);
    this.write = await listen('desktop-browser-act', WRITE_TOOLS, this.deps.browser, this.secret);
    this.register();
  }

  /** Write/refresh the two MCP config files at the active data root. */
  register(): void {
    if (!this.read || !this.write) return;
    const dir = this.deps.mcpDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeCfg(dir, 'desktop-browser', this.read.port, 'readonly', this.secret);
      writeCfg(dir, 'desktop-browser-act', this.write.port, 'write', this.secret);
    } catch {
      /* best-effort: the browser still works without model control */
    }
  }

  dispose(): void {
    this.read?.http.close();
    this.write?.http.close();
  }
}

function writeCfg(dir: string, name: string, port: number, riskTier: 'readonly' | 'write', secret: string): void {
  const cfg = {
    name,
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { authorization: `Bearer ${secret}` },
    enabled: true,
    riskTier,
  };
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}
