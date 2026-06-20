/**
 * MCP integration (agent §3.5). Connects configured MCP servers, bridges their
 * tools into the agent tool set as `mcp__<server>__<tool>`, and routes calls
 * through the same three-state approval (gated by `riskTier`). One hub per
 * session; isolated per server so one crash doesn't take down the others.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tool, jsonSchema, type Tool } from 'ai';
import type { McpServerConfig, RiskTier } from '@enterprise-agent/agent-contract';
import type { KeyStore } from '../config/keychain.js';
import type { RunContext } from '../runtime/context.js';
import { gated, ToolRejectedError } from '../tools/gate.js';
import { readJson } from '../util/fs.js';

/** A read-only MCP server's tools skip approval; others are gated. */
function requiresApproval(tier: RiskTier | undefined): boolean {
  return tier !== 'readonly';
}

function resolveSecrets(
  rec: Record<string, string | { keyRef: string }> | undefined,
  keychain: KeyStore,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec ?? {})) {
    if (typeof v === 'string') out[k] = v;
    else {
      const secret = keychain.get(v.keyRef);
      if (secret !== undefined) out[k] = secret;
    }
  }
  return out;
}

/**
 * Base environment for a spawned stdio MCP server: the host env MINUS the
 * agent's own secret store (`ENTERPRISE_AGENT_KEY_*`, read by `EnvKeyStore`). A
 * stdio server is third-party code; passing the full parent env would hand it
 * every provider key the host holds. The server still gets PATH/HOME/etc. it
 * needs to launch, plus only the `keyRef`-resolved vars it declared (agent §4).
 */
function childBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith('ENTERPRISE_AGENT_KEY_')) continue;
    out[k] = v;
  }
  return out;
}

interface RemoteToolDesc {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  client: Client;
  cfg: McpServerConfig;
  remote: RemoteToolDesc[];
}

export class McpHub {
  private clients: Client[] = [];
  private servers: ConnectedServer[] = [];

  constructor(private readonly keychain: KeyStore) {}

  /** Load server configs from the given JSON file paths (agent §5.2 merge). */
  static loadConfigs(paths: string[]): McpServerConfig[] {
    const byName = new Map<string, McpServerConfig>();
    for (const p of paths) {
      const cfg = readJson<McpServerConfig>(p);
      if (cfg?.enabled) byName.set(cfg.name, cfg); // later (workspace) overrides
    }
    return [...byName.values()];
  }

  private makeTransport(cfg: McpServerConfig) {
    if (cfg.transport === 'stdio') {
      // `stderr: 'pipe'` (not the SDK default `'inherit'`) so the spawned
      // server's stderr — e.g. a package manager's "Resolving dependencies…"
      // when launched via `npx`/`bunx` — does NOT write onto the host terminal
      // and corrupt the TUI's alt-screen. We drain it in `connect` and fold the
      // tail into the error message on failure.
      return new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args ?? [],
        env: { ...childBaseEnv(), ...resolveSecrets(cfg.env, this.keychain) },
        stderr: 'pipe',
      });
    }
    const headers = resolveSecrets(cfg.headers, this.keychain);
    const url = new URL(cfg.url!);
    if (cfg.transport === 'sse') {
      return new SSEClientTransport(url, { requestInit: { headers } });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  /**
   * Per-server connect+listTools budget (agent §3.5 isolation). Without it, a
   * server that spawns but never completes the MCP handshake (a hung stdio
   * child, an unresponsive endpoint) leaves `client.connect` pending forever and
   * blocks the whole session bootstrap. Generous enough for a cold `npx`/`bunx`
   * download; on expiry the server is reported via `onError` and skipped.
   */
  private static readonly CONNECT_TIMEOUT_MS = 60_000;

  /**
   * Connect all servers once (per session), concurrently. A failed/slow server
   * is reported via `onError` and skipped; it never blocks the others — and with
   * the concurrent + bounded connect, it can't stall the bootstrap beyond the
   * per-server timeout either (agent §3.5 isolation).
   */
  async connect(
    configs: McpServerConfig[],
    onError?: (server: string, message: string) => void,
  ): Promise<void> {
    await Promise.all(configs.map((cfg) => this.connectOne(cfg, onError)));
  }

  private async connectOne(
    cfg: McpServerConfig,
    onError?: (server: string, message: string) => void,
  ): Promise<void> {
    const transport = this.makeTransport(cfg);
    // Drain a piped stdio stderr so it neither corrupts the terminal nor
    // backpressures the child; keep only the tail for failure diagnostics.
    let stderrTail = '';
    const stderrStream = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr;
    stderrStream?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    const client = new Client(
      { name: `enterprise-agent-${cfg.name}`, version: '0.0.1' },
      { capabilities: {} },
    );
    try {
      await withTimeout(client.connect(transport), McpHub.CONNECT_TIMEOUT_MS, `MCP '${cfg.name}' connection`);
      const { tools: remote } = await withTimeout(
        client.listTools(),
        McpHub.CONNECT_TIMEOUT_MS,
        `MCP '${cfg.name}' listTools`,
      );
      this.clients.push(client);
      this.servers.push({ client, cfg, remote: remote as RemoteToolDesc[] });
    } catch (err) {
      // Tear the half-open client/child down so a hung server (and its spawned
      // stdio process) isn't left running for the rest of the session.
      await client.close().catch(() => {});
      const tail = stderrTail.trim();
      onError?.(cfg.name, tail ? `${err}\n${tail}` : String(err));
    }
  }

  /**
   * Wrap connected servers' tools for a specific agent context, keyed
   * `mcp__server__tool`. `allow` enforces the sub-agent role MCP gate (§3.4).
   */
  wrapAll(ctx: RunContext, allow?: (fqName: string) => boolean): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    for (const { client, cfg, remote } of this.servers) {
      for (const t of remote) {
        const fqName = `mcp__${cfg.name}__${t.name}`;
        if (allow && !allow(fqName)) continue;
        tools[fqName] = this.wrap(client, cfg, t, fqName, ctx);
      }
    }
    return tools;
  }

  private wrap(
    client: Client,
    cfg: McpServerConfig,
    remote: RemoteToolDesc,
    fqName: string,
    ctx: RunContext,
  ): Tool {
    const call = async (args: unknown) => {
      const res = await client.callTool({ name: remote.name, arguments: args as Record<string, unknown> });
      return res;
    };
    return tool({
      description: remote.description ?? `MCP tool ${fqName}`,
      inputSchema: jsonSchema((remote.inputSchema as object) ?? { type: 'object' }),
      execute: async (args, { toolCallId }) => {
        if (!requiresApproval(cfg.riskTier)) return call(args);
        try {
          return await gated(
            ctx,
            {
              toolName: fqName,
              toolCallId,
              input: args,
              grantKey: fqName,
              grantScope: `call ${fqName} for this task`,
            },
            () => call(args),
          );
        } catch (e) {
          if (e instanceof ToolRejectedError) return { error: 'rejected' };
          throw e;
        }
      },
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.close()));
    this.clients = [];
  }
}

/** Reject if `p` doesn't settle within `ms`. The timer is unref'd so it never
 *  keeps the process alive on its own. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
