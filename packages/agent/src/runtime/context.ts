/**
 * Runtime context (agent §2.5). The merged Session context handed to tool
 * builders and the sub-agent spawner. Each agent (orchestrator or sub) gets its
 * own context carrying its `agentId`; services below are shared per session so
 * the grant table / accountant / audit are session-wide.
 */
import type { LanguageModel } from 'ai';
import type {
  AgentStreamEvent,
  Artifact,
  ExecutionMode,
  MemoryPort,
  MemoryScope,
  PermissionPolicy,
  Todo,
  UsageTotals,
} from '@dami-sg/agent-contract';
import type { ApprovalController } from '../approval/approval.js';
import type { QuestionController } from './question.js';
import type { PlanController } from './plan.js';
import type { AutoClassifyInput, AutoClassifierResult } from './auto-classifier.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { RunStore } from '../storage/run-store.js';
import type { SessionStore } from '../storage/session-store.js';
import type { Accountant } from './accountant.js';
import type { UsageLedger } from '../storage/usage-ledger.js';
import type { Sandbox, SandboxPolicy } from '../sandbox/sandbox.js';
import type { ModelMetaRegistry } from '../models/meta.js';
import type { KeyStore } from '../config/keychain.js';
import type { Semaphore } from '../util/semaphore.js';
import type { EffectiveDynamicSubAgents } from '../config/store.js';

/** Services shared across all agents within one session (agent §1). */
export interface SessionServices {
  sessionId: string;
  approval: ApprovalController;
  /** Interactive elicitation round-trip for the `askUserQuestion` tool. */
  questions: QuestionController;
  /** Plan proposal round-trip for the `exitPlanMode` tool (agent §3.8.4). */
  plan: PlanController;
  audit: AuditStore;
  runs: RunStore;
  session: SessionStore;
  accountant: Accountant;
  /** Durable multi-dimensional usage ledger (agent §2.7). Host-global, shared
   *  across sessions; every model call appends one fact here. */
  usageLedger: UsageLedger;
  sandbox: Sandbox;
  sandboxPolicy: SandboxPolicy;
  meta: ModelMetaRegistry;
  keychain: KeyStore;
  permission: PermissionPolicy;
  /**
   * The session's live execution mode (agent §3.8). A mutable ref (like
   * `needsCompaction`) shared across the orchestrator and all sub-agents, so a
   * `setExecutionMode` mid-run is seen by the next gate decision everywhere.
   */
  executionMode: { value: ExecutionMode };
  /** Allow network-tier tools during plan-mode exploration (agent §3.8.4). */
  planAllowNetwork: boolean;
  /**
   * Unattended run (§7 B.2): a scheduled fire with no human to answer approvals.
   * A mutable ref (like `executionMode`) shared across the orchestrator and all
   * sub-agents. When true, any tool call that would reach the interactive
   * approval gate is DENIED (fail-closed) rather than hanging on a prompt that
   * will never be answered. Pre-authorized grants are honored before the gate, so
   * they still run; everything else high-risk is denied.
   */
  unattended: { value: boolean };
  /**
   * Auto-mode adjudicator (agent §3.8.5). `enabled` is the resolved circuit
   * breaker; `classify` runs the safety classifier on a high-risk call. Used by
   * the gate only when `executionMode === 'auto'`. (The `full` mode skips this
   * and uses the deterministic high-risk gate in tools/full-mode-policy.ts.)
   */
  auto: {
    enabled: boolean;
    /** Concrete `provider:model` ref of the classifier (for cost accounting §2.7). */
    modelRef: string;
    classify(call: AutoClassifyInput, abortSignal?: AbortSignal): Promise<AutoClassifierResult>;
  };
  /** File access boundary (agent §4): the session's workingDir or its scratch/. */
  rootPaths: string[];
  /**
   * Skill root directories (agent §3.6). Part of the execution boundary as
   * read + run, never write: a skill's bundled scripts/assets can be executed
   * from where they live, but the writable boundary stays `rootPaths` only.
   */
  skillRoots: string[];
  /**
   * Extra read-only roots (agent §4 / GlobalSettings.readRoots). Same boundary
   * tier as `skillRoots` — read + run, never write — but not skill dirs, so they
   * are not scanned by the skill registry. Joined to the exec cwd guard and the
   * sandbox read allowlist; the file tools' writable boundary stays `rootPaths`.
   */
  readRoots: string[];
  maxDepth: number;
  maxConcurrency: number;
  /**
   * Self-generated (dynamic) sub-agents envelope (dynamic-subagents §D2). The
   * SOLE capability ceiling once preset roles are gone: a synthesized worker's
   * granted caps = requested ∩ parent ∩ this. `enabled:false` → the orchestrator
   * never receives `delegateToSubAgent`.
   */
  dynamicSubAgents: EffectiveDynamicSubAgents;
  /** Caps concurrent sub-agent delegation (agent §2.3 pt.3). */
  concurrency: Semaphore;
  emit(event: AgentStreamEvent): void;
  /** Replace the session-level todo list (agent §3.7, full replacement). */
  setTodos(todos: Todo[]): void;
  getTodos(): Todo[];
  /** Record a new session artifact (agent §artifacts) — a model deliverable. */
  addArtifact(artifact: Artifact): void;
  /** Every artifact registered in this session, oldest first. */
  listArtifacts(): Artifact[];
  /** Persist cumulative usage + current context occupancy so the UI can restore
   * the token/cost/window readout when the session is re-opened (agent §2.1).
   * `lastInputTokens` / `contextWindow` are omitted by auxiliary (non-orchestrator)
   * calls so they update totals without clobbering the orchestrator's gauge. */
  persistUsage(usage: UsageTotals, lastInputTokens?: number, contextWindow?: number): void;
  /** The orchestrator's model (agent §2.6); sub-agents default to it too. */
  orchestratorModel(): LanguageModel;
  /** Concrete `provider:model` ref of the orchestrator's model (cost accounting). */
  orchestratorModelRef(): string;
  /**
   * Resolve an explicit alias or `provider:model` ref to a model — used for an
   * agent definition's `model:` override (declarative sub-agents), bypassing the
   * role→alias mapping. Unresolvable refs fall back per §2.6.
   */
  modelForAlias(aliasOrRef: string): LanguageModel;
  /** Concrete `provider:model` ref for an explicit alias/ref (cost accounting). */
  modelRefForAlias(aliasOrRef: string): string;
  nextSubId(): number;
  /** Wrap connected MCP tools for an agent context (agent §3.5). */
  wrapMcpTools(ctx: RunContext, allow?: (fqName: string) => boolean): Record<string, import('ai').Tool>;
  /**
   * Skill catalog for a sub-agent, filtered to skills it can carry out with the
   * given tool names (agent §2.3 / §3.6). `query` (the delegated objective)
   * drives the relevance prefetch in search mode. Empty string when none apply.
   */
  subAgentSkillCatalog(toolNames: string[], query?: string): string;
  /**
   * Load a skill's full body for the `useSkill` tool (progressive disclosure,
   * agent §3.6). `allowedToolNames` bounds visibility to skills the agent can
   * carry out; omit for the orchestrator. `not_available` = exists but not
   * model-invocable / not carryable; `not_found` = no such skill.
   */
  loadSkill(
    name: string,
    allowedToolNames?: string[],
  ): { name: string; body: string; dir: string } | { error: 'not_found' | 'not_available' };
  /** Relevance-ranked skill search for the `searchSkills` tool (agent §3.6). */
  searchSkills(query: string, allowedToolNames?: string[]): { name: string; description: string }[];
  /**
   * Cross-session memory backend (memory §1). Undefined when memory is disabled
   * or no `MemoryPort` was provided to the host → the turn-loop hooks (memory
   * §3) all no-op and behavior is identical to having no memory at all.
   */
  memory?: MemoryPort;
  /** Resolved isolation scope for this session's memory (memory §4). */
  memoryScope?: MemoryScope;
  /** Retrieve tuning for the turn-start hook (memory §3/§5). */
  memoryRetrieve?: { topK: number; timeoutMs: number };
}

/** Per-agent context = shared services + this agent's identity/run/depth. */
export interface RunContext {
  shared: SessionServices;
  runId: string;
  agentId: string;
  parentAgentId?: string;
  /** Sub-agent nesting depth (agent §2.3); 0 = orchestrator. */
  depth: number;
  /**
   * The turn's root entry (the user entry that started this run). Sub-agent
   * transcripts hang off it instead of moving the active head (agent §5.6).
   */
  rootEntryId?: string;
  /** Compaction flag set by onStepFinish, consumed by prepareStep (agent §5.5). */
  needsCompaction: { value: boolean };
  abortSignal: AbortSignal;
}

/**
 * Derive a child context for a spawned sub-agent (agent §2.3). `abortSignal`
 * defaults to the parent's; the spawner passes a combined parent-abort + timeout
 * signal so the sub-agent's own tool calls cascade-abort on timeout too.
 */
export function deriveSubContext(
  parent: RunContext,
  agentId: string,
  runId: string,
  abortSignal: AbortSignal = parent.abortSignal,
): RunContext {
  return {
    shared: parent.shared,
    runId,
    agentId,
    parentAgentId: parent.agentId,
    depth: parent.depth + 1,
    rootEntryId: parent.rootEntryId,
    needsCompaction: { value: false },
    abortSignal,
  };
}
