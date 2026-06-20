/**
 * Command contract (agent §6.1): host → module, request style.
 * Transport-agnostic — desktop carries it over Electron IPC, a CLI over stdio.
 */
import type {
  ExecutionMode,
  PlanDecision,
  ProviderModelsResult,
  ScopedConfig,
  Session,
  Todo,
  UserQuestionAnswer,
} from './domain.js';
import type { AgentStreamEvent } from './events.js';
import type { Entry } from './storage.js';

/** Three-state approval decision (agent §3.3). */
export const APPROVAL = {
  ONCE: 'once',
  SESSION: 'session',
  REJECT: 'reject',
} as const;

export type ApprovalDecision = (typeof APPROVAL)[keyof typeof APPROVAL];

export interface SessionTreeNode {
  entry: Entry;
  children: SessionTreeNode[];
}

export interface SessionTree {
  rootId?: string;
  headId?: string;
  nodes: Record<string, Entry>;
  labels: Record<string, string>;
  root?: SessionTreeNode;
}

export interface CreateSessionInput {
  name: string;
  /** Optional working directory; unset → default working dir (agent §1.1). */
  workingDir?: string;
  config?: ScopedConfig;
}

export interface StartSessionInput extends CreateSessionInput {
  /** The first message that starts the session's run. */
  goal: string;
}

/**
 * The agent core's outward command surface. A host obtains an instance via
 * the package entry point and drives sessions through it. Sessions are
 * addressed uniformly by `sessionId` (agent §6.1).
 */
export interface AgentHost {
  // -- session management (agent §6.1) --
  listSessions(): Promise<Session[]>;
  createSession(input: CreateSessionInput): Promise<Session>;
  updateSessionConfig(sessionId: string, config: ScopedConfig): Promise<Session>;
  /** Rename a session (e.g. auto-titling after the first turn, agent §1.1). */
  renameSession(sessionId: string, name: string): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  switchSession(sessionId: string): Promise<void>;

  /**
   * Derive a short title from the session's first exchange (agent §2.4). Used to
   * auto-name a freshly created session after its first round. Returns '' if
   * there's nothing to title or the model call fails.
   */
  generateTitle(sessionId: string): Promise<string>;

  // -- session driving --
  startSession(input: StartSessionInput): Promise<{ sessionId: string; runId: string }>;
  sendMessage(sessionId: string, text: string): Promise<{ runId: string }>;
  approveTool(toolCallId: string, decision: ApprovalDecision): void;
  /**
   * Switch the session's execution mode (agent §3.8). Live-mutable: takes effect
   * on the next gate decision; an in-flight tool call keeps its decision. Emits
   * `mode-changed`. No-op if the session isn't open yet (its config default applies).
   */
  setExecutionMode(sessionId: string, mode: ExecutionMode): void;
  /**
   * Resolve a pending `plan-proposed` (agent §3.8.4). `approve`/`edit` switch the
   * session out of plan mode (into `opts.targetMode`, default ask) and pre-grant
   * the plan's declared actions; `edit` uses `opts.editedPlan` as the final plan;
   * `keep` returns the orchestrator to read-only refinement; `reject` abandons it.
   */
  approvePlan(
    planId: string,
    decision: PlanDecision,
    opts?: { editedPlan?: string; targetMode?: ExecutionMode },
  ): void;
  /**
   * Deliver the user's selection for a pending `user-question-required`
   * (askUserQuestion). `answers` is aligned to the emitted `questions`; pass
   * `null` when the user dismisses without answering (the run continues and the
   * tool reports the dismissal to the model).
   */
  answerQuestion(questionId: string, answers: UserQuestionAnswer[] | null): void;
  abortRun(runId: string): void;

  // -- session tree ops (agent §6.1) --
  forkFrom(sessionId: string, entryId: string): Promise<void>;
  labelEntry(sessionId: string, entryId: string, label: string): Promise<void>;
  /** Manually compact the session's active context (agent §5.5 `manual`).
   *  Threshold/overflow compaction happen automatically during a run. */
  compact(sessionId: string): Promise<void>;
  getSessionTree(sessionId: string): Promise<SessionTree>;
  cloneToSession(sessionId: string, leafId: string): Promise<{ sessionId: string }>;
  getTodos(sessionId: string): Promise<Todo[]>;

  /** Structured output (agent §2.4): run the session to produce typed data. */
  report(sessionId: string, prompt: string): Promise<unknown>;

  /** Model discovery (agent §2.6): list a provider's available models. */
  listProviderModels(
    providerId: string,
    opts?: { refresh?: boolean },
  ): Promise<ProviderModelsResult>;

  // -- event subscription (agent §6.2) --
  onEvent(listener: (event: AgentStreamEvent) => void): () => void;

  dispose(): Promise<void>;
}
