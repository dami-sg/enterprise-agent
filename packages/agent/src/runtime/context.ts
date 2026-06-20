/**
 * Runtime context (agent §2.5). The merged Session context handed to tool
 * builders and the sub-agent spawner. Each agent (orchestrator or sub) gets its
 * own context carrying its `agentId`; services below are shared per session so
 * the grant table / accountant / audit are session-wide.
 */
import type { LanguageModel } from 'ai';
import type {
  AgentStreamEvent,
  ExecutionMode,
  PermissionPolicy,
  Todo,
  UsageTotals,
} from '@enterprise-agent/agent-contract';
import type { ApprovalController } from '../approval/approval.js';
import type { QuestionController } from './question.js';
import type { PlanController } from './plan.js';
import type { AutoClassifyInput, AutoClassifierResult } from './auto-classifier.js';
import type { AuditStore } from '../storage/audit-store.js';
import type { RunStore } from '../storage/run-store.js';
import type { SessionStore } from '../storage/session-store.js';
import type { Accountant } from './accountant.js';
import type { Sandbox, SandboxPolicy } from '../sandbox/sandbox.js';
import type { ModelMetaRegistry } from '../models/meta.js';
import type { KeyStore } from '../config/keychain.js';
import type { Semaphore } from '../util/semaphore.js';

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
   * Auto-mode adjudicator (agent §3.8.5). `enabled` is the resolved circuit
   * breaker; `classify` runs the safety classifier on a high-risk call. Used by
   * the gate only when `executionMode === 'auto'`.
   */
  auto: {
    enabled: boolean;
    classify(call: AutoClassifyInput, abortSignal?: AbortSignal): Promise<AutoClassifierResult>;
  };
  /** File access boundary (agent §4): the session's workingDir or its scratch/. */
  rootPaths: string[];
  maxDepth: number;
  maxConcurrency: number;
  /** Wall-clock timeout (ms) for a sub-agent run by role; 0 disables (agent §2.3). */
  subAgentTimeoutMs(role: string): number;
  /**
   * Sub-agent roles permitted to spawn nested sub-agents (agent §2.3 pt.2,
   * opt-in via config). A role outside this set never receives the
   * `delegateToSubAgent` tool, regardless of depth budget.
   */
  delegateRoles: ReadonlySet<string>;
  /** Caps concurrent sub-agent delegation (agent §2.3 pt.3). */
  concurrency: Semaphore;
  emit(event: AgentStreamEvent): void;
  /** Replace the session-level todo list (agent §3.7, full replacement). */
  setTodos(todos: Todo[]): void;
  getTodos(): Todo[];
  /** Persist cumulative usage + current context occupancy so the UI can restore
   * the token/cost/window readout when the session is re-opened (agent §2.1). */
  persistUsage(usage: UsageTotals, lastInputTokens: number): void;
  /** Resolve a role to a model with agent §2.6 precedence. */
  modelFor(role: string): LanguageModel;
  /** Concrete `provider:model` ref for a role (for cost accounting). */
  modelRefFor(role: string): string;
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
  ): { name: string; body: string } | { error: 'not_found' | 'not_available' };
  /** Relevance-ranked skill search for the `searchSkills` tool (agent §3.6). */
  searchSkills(query: string, allowedToolNames?: string[]): { name: string; description: string }[];
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
