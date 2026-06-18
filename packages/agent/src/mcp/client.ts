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
      return new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args ?? [],
        env: { ...process.env as Record<string, string>, ...resolveSecrets(cfg.env, this.keychain) },
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
   * Connect all servers once (per session). A failed server is reported via
   * `onError` and skipped; it never blocks the others (agent §3.5 isolation).
   */
  async connect(
    configs: McpServerConfig[],
    onError?: (server: string, message: string) => void,
  ): Promise<void> {
    for (const cfg of configs) {
      try {
        const client = new Client(
          { name: `enterprise-agent-${cfg.name}`, version: '0.4.0' },
          { capabilities: {} },
        );
        await client.connect(this.makeTransport(cfg));
        this.clients.push(client);
        const { tools: remote } = await client.listTools();
        this.servers.push({ client, cfg, remote: remote as RemoteToolDesc[] });
      } catch (err) {
        onError?.(cfg.name, String(err));
      }
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
