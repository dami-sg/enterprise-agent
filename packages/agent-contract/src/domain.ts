/**
 * Domain models (agent §1, §2.5, §2.6, §3.7).
 *
 * These are the persisted / config-facing shapes shared between the agent core
 * and any host (desktop, cli). Kept dependency-free so hosts can import them
 * without pulling in the AI SDK runtime.
 */

// ---------------------------------------------------------------------------
// Model provider & registry (agent §2.6)
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'openai-compatible'
  | 'gateway';

/** Provider access config (persisted, global scope). Secrets live in keychain. */
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Custom endpoint — required for `openai-compatible`. */
  baseURL?: string;
  /** Reference name into the OS keychain; never the plaintext key (agent §4). */
  keyRef?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export type ModelCapability =
  | 'tools'
  | 'structured-output'
  | 'vision'
  | 'reasoning';

/** Semantic alias mapping a role name → concrete `providerId:modelId`. */
export interface ModelAlias {
  /** e.g. 'orchestrator' | 'fast' | 'reasoning' | 'vision'. */
  alias: string;
  /** e.g. 'anthropic:claude-sonnet-4.5'. */
  ref: string;
  params?: {
    maxOutputTokens?: number;
    temperature?: number;
    providerOptions?: Record<string, unknown>;
  };
  capabilities?: ModelCapability[];
}

/** Per-Mtok pricing (USD). */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

/** Model metadata (agent §2.6 pt.6) — prerequisite for cost + compaction. */
export interface ModelMeta {
  ref: string;
  contextWindow: number;
  maxOutputTokens: number;
  price?: ModelPrice;
  capabilities?: ModelCapability[];
}

// ---------------------------------------------------------------------------
// Permission / sandbox policy (agent §3, §4)
// ---------------------------------------------------------------------------

export interface PermissionPolicy {
  /** Absolute path prefixes that file tools may touch (beyond the root). */
  allowPaths?: string[];
  /** argv[0] executables auto-allowed without approval. */
  allowCommands?: string[];
  /** argv[0] executables always denied. */
  denyCommands?: string[];
  /** Tool names that always require approval, overriding defaults. */
  requireApproval?: string[];
  /** Outbound host allowlist for network tools / MCP. Empty = allow none. */
  allowHosts?: string[];
}

export interface SandboxConfig {
  /** Defaults to global `settings.sandbox.enabled` when omitted. */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// MCP (agent §3.5)
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'sse' | 'http';
export type RiskTier = 'readonly' | 'write' | 'exec' | 'network';

export interface McpKeyRef {
  keyRef: string;
}

export interface McpServerConfig {
  name: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string | McpKeyRef>;
  /** sse / http */
  url?: string;
  headers?: Record<string, string | McpKeyRef>;
  enabled: boolean;
  riskTier?: RiskTier;
}

// ---------------------------------------------------------------------------
// Config scope (global → Workspace/Chat), agent §2.5 / §5.2
// ---------------------------------------------------------------------------

export interface ModelConfig {
  /** Default alias used by the orchestrator. */
  orchestratorAlias?: string;
  /** Role → alias overrides for sub-agents. */
  roleAliases?: Record<string, string>;
}

/** Config block that can be set globally and overridden per Workspace/Chat. */
export interface ScopedConfig {
  model?: ModelConfig;
  /** Alias map overrides (agent §2.6 pt.3). */
  aliases?: ModelAlias[];
  sandbox?: SandboxConfig;
  permission?: PermissionPolicy;
  /** Max orchestrator steps. */
  maxSteps?: number;
}

/** Global defaults persisted in `~/.enterprise-agent/settings.json`. */
export interface GlobalSettings extends ScopedConfig {
  /** Compaction trigger ratio of context window (agent §2.7 / §5.5). Default 0.9. */
  compactRatio?: number;
  /** Max sub-agent nesting depth (agent §2.3). Default 3. */
  maxDepth?: number;
  /** Global concurrency cap for parallel sub-agent delegation. */
  maxConcurrency?: number;
}

// ---------------------------------------------------------------------------
// Workspace / Work / Chat (agent §1)
// ---------------------------------------------------------------------------

export type WorkStatus = 'active' | 'running' | 'done' | 'archived';

export interface Workspace {
  id: string;
  name: string;
  /** Code-base directory = file access boundary (agent §4). */
  rootPath: string;
  isActive: boolean;
  config: ScopedConfig;
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cost: number;
}

export interface Work {
  id: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: WorkStatus;
  /** Mirror of the active session head (agent §5.3). */
  headEntryId?: string;
  todos: Todo[];
  usage: UsageTotals;
}

/** Chat = Workspace-less session with a private scratch dir (agent §1.2). */
export interface Chat {
  id: string;
  name: string;
  config: ScopedConfig;
  status: WorkStatus;
  headEntryId?: string;
  todos: Todo[];
  usage: UsageTotals;
}

/** A session is addressed uniformly whether it is a Work or a Chat (agent §6.1). */
export type SessionKind = 'work' | 'chat';

export interface SessionRef {
  kind: SessionKind;
  id: string;
}
