/**
 * Config store and two-level scope merge (agent §2.5 / §5.2): global → Workspace
 * (or global → Chat). Providers + their key references are global (agent §2.6).
 */
import type {
  ExecutionMode,
  GlobalSettings,
  ModelAlias,
  ProviderConfig,
  ScopedConfig,
  PermissionPolicy,
} from '@enterprise-agent/agent-contract';
import type { Paths } from './paths.js';
import { listFiles, readJson, writeJson } from '../util/fs.js';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import type { McpServerConfig } from '@enterprise-agent/agent-contract';
import { ROLE_TOOL_POLICY, type SubAgentRole } from '../runtime/prompts.js';

/** All sub-agent role names (config validation + the `none` sentinel). */
export const SUB_AGENT_ROLES = Object.keys(ROLE_TOOL_POLICY) as SubAgentRole[];

/**
 * An MCP server name becomes a filename (`<name>.json`) under the MCP config
 * dir, so it must not be able to escape that directory. Reject anything with a
 * path separator, `..`, leading dot, or non-portable characters — otherwise a
 * crafted/typo'd name (`../../providers`, an absolute path) would let
 * `saveMcpServer`/`removeMcpServer` write or delete files outside the MCP dir.
 */
export function assertSafeServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(
      `invalid MCP server name '${name}': use letters, digits, '.', '_' or '-' (no path separators or '..')`,
    );
  }
}

/** Roles allowed to nest-delegate when config says nothing (agent §2.3 pt.2). */
function defaultDelegateRoles(): string[] {
  return SUB_AGENT_ROLES.filter((r) => ROLE_TOOL_POLICY[r].delegate);
}

export const DEFAULT_SETTINGS: Required<
  Pick<GlobalSettings, 'compactRatio' | 'maxDepth' | 'maxConcurrency' | 'maxSteps' | 'subAgentTimeoutMs'>
> & { sandbox: { enabled: boolean; network: boolean } } = {
  compactRatio: 0.9,
  maxDepth: 3,
  maxConcurrency: 4,
  maxSteps: 40,
  // Wall-clock cap for one sub-agent delegation (agent §2.3); 0 disables.
  subAgentTimeoutMs: 300_000,
  // Sandbox bounds filesystem writes by default; network is OPEN by default so
  // network tools work, and can be turned off for full isolation (agent §4.1).
  sandbox: { enabled: true, network: true },
};

/** Effective config after merging global settings with a scope override. */
export interface EffectiveConfig {
  orchestratorAlias: string;
  roleAliases: Record<string, string>;
  aliases: ModelAlias[];
  sandboxEnabled: boolean;
  /** Whether sandboxed subprocesses may reach the network (default true). */
  sandboxNetwork: boolean;
  permission: PermissionPolicy;
  /** Default execution mode for the session (agent §3.8); default 'ask'. */
  executionMode: ExecutionMode;
  /** Allow network-tier tools during plan-mode exploration (agent §3.8.4); default true. */
  planAllowNetwork: boolean;
  /** Auto-mode circuit breaker (agent §3.8.5): a global `false` cannot be
   *  re-enabled by a session override (one-way tightening). Default true. */
  autoEnabled: boolean;
  /** Semantic alias for the auto-mode classifier model (agent §3.8.5). */
  classifierAlias: string;
  maxSteps: number;
  compactRatio: number;
  maxDepth: number;
  maxConcurrency: number;
  /** Default wall-clock timeout (ms) for one sub-agent run; 0 disables (agent §2.3). */
  subAgentTimeoutMs: number;
  /** Per-role timeout overrides (ms), keyed by role; wins over the default. */
  roleTimeoutMs: Record<string, number>;
  /** Sub-agent roles permitted to nest-delegate (agent §2.3 pt.2). */
  delegateRoles: string[];
}

/** Resolve the effective sub-agent timeout (ms) for a role: a per-role override
 *  if set, else the global default (agent §2.3). 0 means "no timeout". */
export function timeoutForRole(
  eff: Pick<EffectiveConfig, 'subAgentTimeoutMs' | 'roleTimeoutMs'>,
  role: string,
): number {
  return eff.roleTimeoutMs[role] ?? eff.subAgentTimeoutMs;
}

export class ConfigStore {
  constructor(private readonly paths: Paths) {}

  loadSettings(): GlobalSettings {
    return readJson<GlobalSettings>(this.paths.settings) ?? {};
  }

  saveSettings(settings: GlobalSettings): void {
    writeJson(this.paths.settings, settings);
  }

  loadProviders(): ProviderConfig[] {
    return readJson<ProviderConfig[]>(this.paths.providers) ?? [];
  }

  saveProviders(providers: ProviderConfig[]): void {
    writeJson(this.paths.providers, providers);
  }

  /** Global aliases + per-file global skill aliases overrides. */
  loadGlobalAliases(): ModelAlias[] {
    return readJson<ModelAlias[]>(this.paths.aliases) ?? [];
  }

  saveGlobalAliases(aliases: ModelAlias[]): void {
    writeJson(this.paths.aliases, aliases);
  }

  /** Load session-level alias overrides (agent §5.2). */
  loadSessionAliases(sessionId: string): ModelAlias[] {
    return readJson<ModelAlias[]>(this.paths.sessionAliases(sessionId)) ?? [];
  }

  // -- MCP server configs (agent §3.5, one JSON file per server) --

  listMcpServers(sessionId?: string): McpServerConfig[] {
    return this.mcpConfigPaths(sessionId)
      .map((p) => readJson<McpServerConfig>(p))
      .filter((c): c is McpServerConfig => Boolean(c));
  }

  saveMcpServer(cfg: McpServerConfig, sessionId?: string): void {
    assertSafeServerName(cfg.name);
    const dir = sessionId ? this.paths.sessionMcp(sessionId) : this.paths.mcp;
    writeJson(join(dir, `${cfg.name}.json`), cfg);
  }

  removeMcpServer(name: string, sessionId?: string): boolean {
    assertSafeServerName(name);
    const dir = sessionId ? this.paths.sessionMcp(sessionId) : this.paths.mcp;
    const file = join(dir, `${name}.json`);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  /**
   * Merge global settings with a scope override (a Workspace's or Chat's
   * `config`). Missing items fall back to global, then to built-in defaults.
   */
  effective(scope: ScopedConfig | undefined, scopeAliases: ModelAlias[]): EffectiveConfig {
    const g = this.loadSettings();
    const globalAliases = this.loadGlobalAliases();
    // Alias precedence: scope overrides global by alias name.
    const aliasMap = new Map<string, ModelAlias>();
    for (const a of [...globalAliases, ...(g.aliases ?? []), ...scopeAliases, ...(scope?.aliases ?? [])]) {
      aliasMap.set(a.alias, a);
    }
    const aliases = [...aliasMap.values()];

    const sandboxEnabled =
      scope?.sandbox?.enabled ??
      g.sandbox?.enabled ??
      DEFAULT_SETTINGS.sandbox.enabled;

    const sandboxNetwork =
      scope?.sandbox?.network ??
      g.sandbox?.network ??
      DEFAULT_SETTINGS.sandbox.network;

    const permission: PermissionPolicy = {
      ...(g.permission ?? {}),
      ...(scope?.permission ?? {}),
    };

    return {
      orchestratorAlias:
        scope?.model?.orchestratorAlias ??
        g.model?.orchestratorAlias ??
        'orchestrator',
      roleAliases: {
        ...(g.model?.roleAliases ?? {}),
        ...(scope?.model?.roleAliases ?? {}),
      },
      aliases,
      sandboxEnabled,
      sandboxNetwork,
      permission,
      executionMode: scope?.executionMode ?? g.executionMode ?? 'ask',
      planAllowNetwork: scope?.plan?.allowNetwork ?? g.plan?.allowNetwork ?? true,
      // One-way tightening: a global `false` wins over any session override.
      autoEnabled: g.auto?.enabled === false ? false : scope?.auto?.enabled ?? g.auto?.enabled ?? true,
      classifierAlias: scope?.auto?.classifierAlias ?? g.auto?.classifierAlias ?? 'classifier',
      maxSteps: scope?.maxSteps ?? g.maxSteps ?? DEFAULT_SETTINGS.maxSteps,
      compactRatio: g.compactRatio ?? DEFAULT_SETTINGS.compactRatio,
      maxDepth: g.maxDepth ?? DEFAULT_SETTINGS.maxDepth,
      maxConcurrency: g.maxConcurrency ?? DEFAULT_SETTINGS.maxConcurrency,
      subAgentTimeoutMs: g.subAgentTimeoutMs ?? DEFAULT_SETTINGS.subAgentTimeoutMs,
      // Keep only known roles with a non-negative timeout (stale/garbage ignored).
      roleTimeoutMs: Object.fromEntries(
        Object.entries(g.roleTimeoutMs ?? {}).filter(
          ([r, v]) => (SUB_AGENT_ROLES as string[]).includes(r) && typeof v === 'number' && v >= 0,
        ),
      ),
      // Only roles named in SUB_AGENT_ROLES are honored; unknown names are
      // dropped so a stale config can't widen capability unexpectedly.
      delegateRoles: (scope?.delegateRoles ?? g.delegateRoles ?? defaultDelegateRoles()).filter(
        (r): r is SubAgentRole => (SUB_AGENT_ROLES as string[]).includes(r),
      ),
    };
  }

  /** Discover MCP config files for a scope, merged global → session. */
  mcpConfigPaths(sessionId?: string): string[] {
    const out: string[] = [];
    for (const f of listFiles(this.paths.mcp, '.json')) out.push(join(this.paths.mcp, f));
    if (sessionId) {
      const sdir = this.paths.sessionMcp(sessionId);
      for (const f of listFiles(sdir, '.json')) out.push(join(sdir, f));
    }
    return out;
  }
}
