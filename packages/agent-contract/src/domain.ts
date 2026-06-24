/**
 * Domain models (agent §1, §2.5, §2.6, §3.7).
 *
 * These are the persisted / config-facing shapes shared between the agent core
 * and any host (desktop, cli). Kept dependency-free so hosts can import them
 * without pulling in the AI SDK runtime.
 */
import type { MemorySettings } from './memory.js';

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
  /** Accepts image input (multimodal §3.1). */
  | 'vision'
  /** Accepts PDF document input as a content block (multimodal §3.1). */
  | 'pdf'
  /** Accepts raw audio input (multimodal §3.1). */
  | 'audio'
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

/** One model surfaced by discovery (agent §2.6 Model Discovery). */
export interface DiscoveredModel {
  /** `providerId:modelId`. */
  ref: string;
  /** Raw model id (as returned dynamically, or the tail of a static ref). */
  id: string;
  /** Whether a `ModelMeta` exists (cost + compaction); false → FALLBACK_META. */
  hasMeta: boolean;
  /** Where this entry came from: a live fetch vs built-in/static metadata. */
  source: 'dynamic' | 'static';
}

/** Result of `listProviderModels` (agent §2.6 / §6.1). */
export interface ProviderModelsResult {
  providerId: string;
  /** Union of dynamically-discovered and statically-known models, sorted. */
  models: DiscoveredModel[];
  /** Epoch ms of the dynamic fetch backing this result; 0 if static-only. */
  fetchedAt: number;
  /** Served from the on-disk cache without a network call. */
  cached: boolean;
  /** Set when the dynamic fetch was skipped/failed and we fell back to static. */
  error?: string;
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
  /**
   * Allow sandboxed subprocesses to access the network (agent §4.1). Defaults to
   * `true` (open) so tools like `pip`/`curl` work out of the box; set `false`
   * to fully isolate the network. Coarse (allow-all / deny-all) — the in-process
   * `httpFetch` tool is unaffected either way.
   */
  network?: boolean;
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

/**
 * Execution mode (agent §3.8): who adjudicates a high-risk tool call.
 *   ask  — per-call human approval (the §3.3 baseline / default)
 *   plan — read-only exploration → propose a plan → user approves → execute
 *   auto — an AI classifier adjudicates (allow/deny/ask), uncertain → ask
 * Unlike model/sandbox snapshots, the mode is LIVE-mutable mid-session (it is the
 * user's steering wheel); a switch takes effect on the next gate decision.
 */
export const EXECUTION_MODE = { ASK: 'ask', PLAN: 'plan', AUTO: 'auto' } as const;
export type ExecutionMode = (typeof EXECUTION_MODE)[keyof typeof EXECUTION_MODE];

/**
 * User decision on a proposed plan (agent §3.8.4). `approve` → switch out of plan
 * mode and execute; `edit` → approve a user-edited plan; `keep` → keep refining
 * (stay read-only); `reject` → abandon this plan.
 */
export type PlanDecision = 'approve' | 'edit' | 'keep' | 'reject';

/**
 * A high-risk action the model pre-declares in its plan (agent §3.8.4). On
 * approval each becomes a session grant, so the declared command/path/host runs
 * without a second prompt (the prompt-based-permissions equivalent).
 */
export interface PlanAllowedAction {
  /** Tool name, e.g. 'runCommand' | 'writeFile'. */
  tool: string;
  /** Grant key with the §3.3 grant-key meaning (argv[0] / dir prefix / host). */
  grantKey: string;
  /** Why the plan needs it — shown to the user before they approve. */
  reason: string;
}

/** Plan-mode tuning (agent §3.8.4). */
export interface PlanModeConfig {
  /** Allow network-tier tools (httpFetch / network MCP) during read-only
   *  exploration. Default true (research needs the network; it doesn't touch the
   *  workspace). Set false for fully local plan exploration. */
  allowNetwork?: boolean;
}

/** Auto-mode tuning (agent §3.8.5). */
export interface AutoModeConfig {
  /** Circuit breaker: when false, auto mode silently degrades to ask. A global
   *  `false` cannot be re-enabled by a session override (one-way tightening). */
  enabled?: boolean;
  /** Semantic alias for the classifier model (default 'classifier'). */
  classifierAlias?: string;
  /** Two-stage pipeline selection (default 'both'). */
  classifierStages?: 'both' | 'fast' | 'thinking';
  /** Extra organization rules appended to the classifier system prompt (agent §8) —
   *  e.g. intranet-only commands, IaC restrictions, data-egress bans. */
  rules?: string;
  /**
   * Bypass the classifier in auto mode (agent §3.8.5). When true, most tool
   * calls run without asking; only an un-exemptible high-risk set (mass
   * deletion, privilege escalation, remote-code execution via any interpreter,
   * opening network listeners, disk-level destroyers, and any unvettable
   * script) still routes to the human approval gate. Default false. This is a
   * bounded safety relaxation — see docs/auto-bypass-mode.md (residual egress
   * risk). A global `false` cannot be re-enabled by a session/channel override
   * (one-way tightening, like `enabled`).
   */
  bypass?: boolean;
}

/** Config block that can be set globally and overridden per Workspace/Chat. */
export interface ScopedConfig {
  model?: ModelConfig;
  /** Alias map overrides (agent §2.6 pt.3). */
  aliases?: ModelAlias[];
  sandbox?: SandboxConfig;
  permission?: PermissionPolicy;
  /** Default execution mode for the session (agent §3.8); default 'ask'. */
  executionMode?: ExecutionMode;
  /** Plan-mode tuning (agent §3.8.4). */
  plan?: PlanModeConfig;
  /** Auto-mode tuning (agent §3.8.5). */
  auto?: AutoModeConfig;
  /** Max orchestrator steps. */
  maxSteps?: number;
  /**
   * Agent definitions permitted to themselves spawn nested sub-agents (agent §2.3
   * pt.2, opt-in). Each named agent gets the `delegateToSubAgent` tool — still
   * bounded by both the agent's own `delegate` opt-in AND `maxDepth`. Omitted =
   * built-in defaults (no agent nests); an empty array explicitly disables
   * nesting for every agent. Names match the built-in roles (`researcher`,
   * `coder`, `analyst`, `writer`, `generalist`) or any custom `AGENT.md` name.
   */
  delegateAgents?: string[];
  /**
   * Admin allowlist of which DISK agent definitions (`AGENT.md`) are enabled
   * (agent §2.3). Omitted = all discovered agents enabled; an empty array = only
   * the built-in seeds; a name list = only those disk agents (built-in seeds are
   * always available and unaffected). Built-in names here are harmless no-ops.
   */
  agents?: string[];
  /**
   * Host-supplied memory isolation key for this session (memory §4). The host
   * (gateway: conversation/user id; cli: project slug) knows "who this is"; the
   * core uses it verbatim as `MemoryScope.namespace`, overriding the scope-mode
   * derivation. Omitted → the core derives the namespace from `memory.scope`.
   */
  memoryNamespace?: string;
}

/** Global defaults persisted in `~/.enterprise-agent/settings.json`. */
export interface GlobalSettings extends ScopedConfig {
  /** Default working directory for sessions with no `workingDir` (agent §1.1). */
  defaultWorkingDir?: string;
  /** Compaction trigger ratio of context window (agent §2.7 / §5.5). Default 0.9. */
  compactRatio?: number;
  /** Max sub-agent nesting depth (agent §2.3). Default 3. */
  maxDepth?: number;
  /** Global concurrency cap for parallel sub-agent delegation. */
  maxConcurrency?: number;
  /**
   * Wall-clock timeout (ms) for a single `delegateToSubAgent` run (agent §2.3).
   * On expiry the sub-agent is aborted (cascading to its in-flight tool calls)
   * and the tool returns a structured `timeout` result so the orchestrator can
   * react instead of blocking forever. Default 300000 (5 min); `0` disables it.
   * Per-role overrides live in `roleTimeoutMs`.
   */
  subAgentTimeoutMs?: number;
  /**
   * Per-role wall-clock timeout overrides (ms), keyed by sub-agent role
   * (`researcher` | `coder` | `analyst` | `writer` | `generalist`). A role
   * present here wins over `subAgentTimeoutMs`; `0` disables the timeout for
   * that role. Unknown role keys are ignored. E.g. give `researcher` longer for
   * deep web research.
   */
  roleTimeoutMs?: Record<string, number>;
  /**
   * Cross-session memory capability (memory §5). Off by default; when enabled,
   * the core wires the retrieve/capture turn-loop hooks against the host-
   * provided `MemoryPort`. Global-only in Phase 1.
   */
  memory?: MemorySettings;
}

// ---------------------------------------------------------------------------
// Session (agent §1) — the single conversation entity (unifies the former
// Workspace / Work / Chat). A session optionally binds a working directory;
// when unset it uses a default working directory (a private scratch dir).
// ---------------------------------------------------------------------------

export type SessionStatus = 'active' | 'running' | 'done' | 'archived';

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// ---------------------------------------------------------------------------
// Interactive elicitation (askUserQuestion tool)
//
// Mid-run the orchestrator can pause to ask the user a multiple-choice
// question; the host renders the options and returns the selection. This is the
// same suspend/emit/await/resolve round-trip as tool approval (agent §3.3) —
// the model is the one that *initiates* it via the `askUserQuestion` tool,
// rather than the kernel intercepting a high-risk call.
// ---------------------------------------------------------------------------

export interface UserQuestionOption {
  /** Display text the user selects; echoed back as the answer. */
  label: string;
  /** Optional explanation of the choice / its implications. */
  description?: string;
}

export interface UserQuestion {
  /** The full question text. */
  question: string;
  /** Short chip/tag label (≤12 chars) shown alongside the question. */
  header: string;
  /** Allow selecting more than one option. */
  multiSelect: boolean;
  /** 2–4 distinct choices (mutually exclusive unless `multiSelect`). */
  options: UserQuestionOption[];
}

export interface UserQuestionAnswer {
  /** Selected option labels (or custom free-text the user supplied). */
  selected: string[];
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cost: number;
}

export interface Session {
  id: string;
  name: string;
  /**
   * Optional working directory = file access boundary (agent §4). When unset,
   * the session uses the default working directory (a private scratch dir,
   * agent §1.1) so it never touches a user project.
   */
  workingDir?: string;
  config: ScopedConfig;
  /** The current active session (agent §1.1). */
  isActive: boolean;
  status: SessionStatus;
  /** Mirror of the active session-tree head (agent §5.3). */
  headEntryId?: string;
  todos: Todo[];
  usage: UsageTotals;
  /**
   * Last run's input-token count = current context occupancy (agent §2.6), kept
   * so the UI can restore the `ctx/window %` gauge on re-open (cumulative
   * `usage` covers tokens/cost; this covers the window fill).
   */
  lastInputTokens?: number;
}
