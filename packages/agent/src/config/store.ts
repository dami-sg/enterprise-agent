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
import type { McpServerConfig, SubAgentCapability } from '@enterprise-agent/agent-contract';
import { SUB_AGENT_CAPABILITIES } from '@enterprise-agent/agent-contract';
import type { DynamicSubAgentsSettings } from '@enterprise-agent/agent-contract';

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

export const DEFAULT_SETTINGS: Required<
  Pick<GlobalSettings, 'compactRatio' | 'maxDepth' | 'maxConcurrency' | 'maxSteps'>
> & { sandbox: { enabled: boolean; network: boolean } } = {
  compactRatio: 0.9,
  maxDepth: 3,
  maxConcurrency: 4,
  maxSteps: 40,
  // Sandbox (landstrip) is OFF by default — commands then run unwrapped, gated
  // only by the app-layer approval + path checks. Turn it on per-need with
  // `ea config sandbox on` (or `sandbox.enabled` in settings.json). When on,
  // network stays OPEN by default so network tools work (agent §4.1).
  sandbox: { enabled: false, network: true },
};

/**
 * Effective (resolved) dynamic sub-agents envelope (dynamic-subagents §D10.3).
 * The merged + defaulted form of `DynamicSubAgentsSettings`, carried on
 * `EffectiveConfig` and exposed to the runtime as the SOLE capability ceiling.
 */
export interface EffectiveDynamicSubAgents {
  enabled: boolean;
  maxCapabilities: SubAgentCapability[];
  mcpAllow: boolean | string[];
  defaultModel?: string;
  defaultTimeoutMs: number;
  evaluation: { enabled: boolean; when: 'always' | 'on-failure-or-violation'; model?: string };
}

/** Defaults: ON with the FULL capability ceiling — the operator narrows or
 *  disables per need (`ea config dyn off` / `caps` / `mcp`). Every high-risk
 *  action a worker takes still goes through the mode's approval gate + sandbox. */
export const DEFAULT_DYNAMIC_SUBAGENTS: EffectiveDynamicSubAgents = {
  enabled: true,
  maxCapabilities: ['read', 'write', 'exec', 'http'],
  mcpAllow: true,
  defaultTimeoutMs: 300_000,
  evaluation: { enabled: true, when: 'on-failure-or-violation' },
};

/**
 * Merge the dynamic-sub-agents envelope global → session (dynamic-subagents §D2).
 * `enabled` tightens one-way (a global `false` cannot be re-enabled per session,
 * mirroring auto-mode). Capability/MCP ceilings: session wins if set, else
 * global, else the conservative default. Unknown capability tokens are dropped
 * (fail-closed) — a malformed envelope can only narrow, never widen.
 */
export function resolveDynamicSubAgents(
  g?: DynamicSubAgentsSettings,
  scope?: DynamicSubAgentsSettings,
): EffectiveDynamicSubAgents {
  const cleanCaps = (caps?: SubAgentCapability[]): SubAgentCapability[] | undefined =>
    caps ? caps.filter((c) => SUB_AGENT_CAPABILITIES.includes(c)) : undefined;
  const enabled = g?.enabled === false ? false : scope?.enabled ?? g?.enabled ?? DEFAULT_DYNAMIC_SUBAGENTS.enabled;
  return {
    enabled,
    maxCapabilities:
      cleanCaps(scope?.maxCapabilities) ?? cleanCaps(g?.maxCapabilities) ?? DEFAULT_DYNAMIC_SUBAGENTS.maxCapabilities,
    mcpAllow: scope?.mcpAllow ?? g?.mcpAllow ?? DEFAULT_DYNAMIC_SUBAGENTS.mcpAllow,
    defaultModel: scope?.defaultModel ?? g?.defaultModel ?? DEFAULT_DYNAMIC_SUBAGENTS.defaultModel,
    defaultTimeoutMs: scope?.defaultTimeoutMs ?? g?.defaultTimeoutMs ?? DEFAULT_DYNAMIC_SUBAGENTS.defaultTimeoutMs,
    evaluation: {
      enabled: scope?.evaluation?.enabled ?? g?.evaluation?.enabled ?? DEFAULT_DYNAMIC_SUBAGENTS.evaluation.enabled,
      when: scope?.evaluation?.when ?? g?.evaluation?.when ?? DEFAULT_DYNAMIC_SUBAGENTS.evaluation.when,
      model: scope?.evaluation?.model ?? g?.evaluation?.model,
    },
  };
}

/** Effective config after merging global settings with a scope override. */
export interface EffectiveConfig {
  orchestratorAlias: string;
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
  /** Two-stage classifier pipeline selection (agent §3.8.5); default 'both'. */
  classifierStages: 'both' | 'fast' | 'thinking';
  /** Extra organization rules for the classifier system prompt (agent §8). */
  classifierRules?: string;
  maxSteps: number;
  compactRatio: number;
  maxDepth: number;
  maxConcurrency: number;
  /**
   * Extra read-only roots (agent §4 / ScopedConfig.readRoots): the deduped union
   * of global + scope. Read + run, never write; not reachable by file tools.
   */
  readRoots: string[];
  /** Self-generated (dynamic) sub-agents envelope (dynamic-subagents §D2). */
  dynamicSubAgents: EffectiveDynamicSubAgents;
  /** Cross-session memory enabled (memory §1/§5); default false. */
  memoryEnabled: boolean;
  /** Namespace derivation when the host supplies none (memory §4); default 'per-user'. */
  memoryScopeMode: MemoryScopeMode;
  /** Max snippets injected per turn by the retrieve hook (memory §3/§5); default 6. */
  memoryTopK: number;
  /** Retrieve budget (ms) before the hook fails open (memory §3/§5); default 1500. */
  memoryTimeoutMs: number;
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
      aliases,
      sandboxEnabled,
      sandboxNetwork,
      permission,
      executionMode: scope?.executionMode ?? g.executionMode ?? 'ask',
      planAllowNetwork: scope?.plan?.allowNetwork ?? g.plan?.allowNetwork ?? true,
      // One-way tightening: a global `false` wins over any session override.
      autoEnabled: g.auto?.enabled === false ? false : scope?.auto?.enabled ?? g.auto?.enabled ?? true,
      classifierAlias: scope?.auto?.classifierAlias ?? g.auto?.classifierAlias ?? 'classifier',
      classifierStages: scope?.auto?.classifierStages ?? g.auto?.classifierStages ?? 'both',
      // Organization rules merge global → session (session appended after global).
      classifierRules: [g.auto?.rules, scope?.auto?.rules].filter(Boolean).join('\n') || undefined,
      maxSteps: scope?.maxSteps ?? g.maxSteps ?? DEFAULT_SETTINGS.maxSteps,
      compactRatio: g.compactRatio ?? DEFAULT_SETTINGS.compactRatio,
      maxDepth: g.maxDepth ?? DEFAULT_SETTINGS.maxDepth,
      maxConcurrency: g.maxConcurrency ?? DEFAULT_SETTINGS.maxConcurrency,
      // Read roots merge global → scope as a deduped union: a session/channel can
      // grant extra roots but cannot drop globally-configured ones (agent §4).
      readRoots: [...new Set([...(g.readRoots ?? []), ...(scope?.readRoots ?? [])])],
      dynamicSubAgents: resolveDynamicSubAgents(g.dynamicSubAgents, scope?.dynamicSubAgents),
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
