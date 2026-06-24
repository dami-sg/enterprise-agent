/**
 * Config store and two-level scope merge (agent §2.5 / §5.2): global → Workspace
 * (or global → Chat). Providers + their key references are global (agent §2.6).
 */
import type {
  ExecutionMode,
  GlobalSettings,
  ModelAlias,
  MemoryScope,
  MemoryScopeMode,
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

/** Agents allowed to nest-delegate when config says nothing (agent §2.3 pt.2). */
function defaultDelegateAgents(): string[] {
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
  // Sandbox (landstrip) is OFF by default — commands then run unwrapped, gated
  // only by the app-layer approval + path checks. Turn it on per-need with
  // `ea config sandbox on` (or `sandbox.enabled` in settings.json). When on,
  // network stays OPEN by default so network tools work (agent §4.1).
  sandbox: { enabled: false, network: true },
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
  /** Auto-mode bypass (agent §3.8.5): skip the classifier, gating only the
   *  un-exemptible high-risk set. A global `false` cannot be re-enabled by a
   *  session/channel override (one-way tightening). Default false. */
  autoBypass: boolean;
  /** Semantic alias for the auto-mode classifier model (agent §3.8.5). */
  classifierAlias: string;
  /** Two-stage classifier pipeline selection (agent §3.8.5); default 'both'. */
  classifierStages: 'both' | 'fast' | 'thinking';
  /** Extra organization rules for the classifier system prompt (agent §8). */
  classifierRules?: string;
  maxSteps: number;
  compactRatio: number;
  maxDepth: number;
  maxConcurrency: number;
  /** Default wall-clock timeout (ms) for one sub-agent run; 0 disables (agent §2.3). */
  subAgentTimeoutMs: number;
  /** Per-role timeout overrides (ms), keyed by role; wins over the default. */
  roleTimeoutMs: Record<string, number>;
  /** Agent definitions permitted to nest-delegate (agent §2.3 pt.2). */
  delegateAgents: string[];
  /**
   * Admin allowlist of enabled DISK agent definitions (agent §2.3). `undefined` =
   * all enabled; `[]` = only built-in seeds; a name list = only those disk agents.
   */
  agents?: string[];
  /** Cross-session memory enabled (memory §1/§5); default false. */
  memoryEnabled: boolean;
  /** Namespace derivation when the host supplies none (memory §4); default 'per-user'. */
  memoryScopeMode: MemoryScopeMode;
  /** Max snippets injected per turn by the retrieve hook (memory §3/§5); default 6. */
  memoryTopK: number;
  /** Retrieve budget (ms) before the hook fails open (memory §3/§5); default 1500. */
  memoryTimeoutMs: number;
}

/** Resolve the effective sub-agent timeout (ms) for a role: a per-role override
 *  if set, else the global default (agent §2.3). 0 means "no timeout". */
export function timeoutForRole(
  eff: Pick<EffectiveConfig, 'subAgentTimeoutMs' | 'roleTimeoutMs'>,
  role: string,
): number {
  return eff.roleTimeoutMs[role] ?? eff.subAgentTimeoutMs;
}

/**
 * Resolve a session's memory isolation scope (memory §4). A host-supplied
 * `namespace` (gateway conversation/user id, cli project key) always wins —
 * "who this is" is the host's job. Absent one, derive from the scope mode:
 * `global` → a single shared store; `per-project` → the project slug (else
 * `default`); `per-user` without a supplied id collapses to `default` (the
 * single-user local case). Returns the namespace only; tenant/tags are left to
 * the host/backend.
 */
export function resolveMemoryScope(
  eff: Pick<EffectiveConfig, 'memoryScopeMode'>,
  opts: { namespace?: string; projectSlug?: string },
): MemoryScope {
  const namespace =
    opts.namespace ??
    (eff.memoryScopeMode === 'global'
      ? 'global'
      : eff.memoryScopeMode === 'per-project'
        ? opts.projectSlug ?? 'default'
        : 'default');
  return { namespace };
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
      // Bypass is a safety relaxation, so it tightens the SAME way: a global
      // `false` locks it off and no session/channel can re-enable it.
      autoBypass: g.auto?.bypass === false ? false : scope?.auto?.bypass ?? g.auto?.bypass ?? false,
      classifierAlias: scope?.auto?.classifierAlias ?? g.auto?.classifierAlias ?? 'classifier',
      classifierStages: scope?.auto?.classifierStages ?? g.auto?.classifierStages ?? 'both',
      // Organization rules merge global → session (session appended after global).
      classifierRules: [g.auto?.rules, scope?.auto?.rules].filter(Boolean).join('\n') || undefined,
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
      // Raw agent names (built-in or custom). Not filtered against SUB_AGENT_ROLES
      // anymore — custom AGENT.md names are valid here. An unknown name is inert:
      // the delegate gate also requires a real agent def + its own `delegate`
      // opt-in, so a stale name never widens capability (agent §2.3).
      delegateAgents: scope?.delegateAgents ?? g.delegateAgents ?? defaultDelegateAgents(),
      // Admin allowlist of enabled disk agents (undefined = all). Session scope
      // can only further restrict; honor whichever is set, session winning.
      agents: scope?.agents ?? g.agents,
      // Memory is global-only in Phase 1 (memory §5): off by default, so an
      // unconfigured install behaves exactly as before (all hooks no-op).
      memoryEnabled: g.memory?.enabled ?? false,
      memoryScopeMode: g.memory?.scope ?? 'per-user',
      memoryTopK: g.memory?.retrieve?.topK ?? 6,
      memoryTimeoutMs: g.memory?.retrieve?.timeoutMs ?? 1500,
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
