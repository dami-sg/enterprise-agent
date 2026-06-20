/**
 * Stream events (agent §6.2): module → host, one-directional streaming.
 * Hosts merge by `agentId` / `parentAgentId` into a run trace tree.
 */
import type { ExecutionMode, PlanAllowedAction, Todo, UserQuestion } from './domain.js';
import type { CompactionReason } from './storage.js';

/**
 * The fixed `agentId` of the root orchestrator in every run's event stream
 * (agent §2). Sub-agents are assigned generated ids; the orchestrator is always
 * this constant, so a host can recognise root-agent events (and the root run
 * that ends a turn) without hard-coding the literal. The runtime emits it and
 * hosts fold against it — single source of truth across the package boundary.
 */
export const ORCHESTRATOR_AGENT_ID = 'orch';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type AgentStreamEvent =
  | { kind: 'text-delta'; runId: string; agentId: string; text: string }
  /**
   * Streamed model reasoning ("thinking", agent §2.2). The runtime normalizes
   * every provider format — native reasoning parts AND inline `<think>` tags —
   * into this one event via the AI SDK's `extractReasoningMiddleware`, so the UI
   * renders thinking the same way regardless of provider.
   */
  | { kind: 'reasoning-delta'; runId: string; agentId: string; text: string }
  | {
      kind: 'tool-call';
      runId: string;
      agentId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: 'tool-approval-required';
      runId: string;
      agentId: string;
      parentAgentId?: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Human-readable scope this approval would grant (agent §3.3). */
      grantScope?: string;
    }
  /**
   * The orchestrator asked the user a multiple-choice question via the
   * `askUserQuestion` tool and the run is suspended awaiting the answer. Hosts
   * render the options and reply with `answerQuestion(questionId, …)`. Same
   * disable-input-while-pending invariant as approval (cli-ui §4 / cli §6.3).
   */
  | {
      kind: 'user-question-required';
      runId: string;
      agentId: string;
      parentAgentId?: string;
      /** Correlates the answer back to the suspended call (= the toolCallId). */
      questionId: string;
      questions: UserQuestion[];
    }
  | {
      kind: 'tool-result';
      runId: string;
      agentId: string;
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    }
  | { kind: 'step-finish'; runId: string; agentId: string; usage: TokenUsage }
  | {
      kind: 'usage';
      runId: string;
      agentId: string;
      /** This step's usage. */
      usage: TokenUsage;
      /** Session-cumulative usage (incl. sub-agents + the persisted seed). */
      totalUsage: TokenUsage;
      /** Session-cumulative cost in USD (0 when the model has no pricing). */
      cost: number;
      /**
       * The model's context window (agent §2.6). Lets the UI show how much of
       * the window the live `inputTokens` consume. Optional for back-compat.
       */
      contextWindow?: number;
      /**
       * The model's max output reservation (agent §2.6 / §5.5). Emitted so the
       * agent and UI can compute the usable input budget = context − maxOutput.
       * Pre-filled from `FALLBACK_META` when the model has no registered meta.
       */
      maxOutputTokens?: number;
    }
  | { kind: 'todo-update'; sessionId: string; todos: Todo[] }
  | {
      kind: 'sub-agent-start';
      runId: string;
      /** The spawning (parent) run's id — the orchestrator turn, or a parent
       *  sub-agent. Lets a host admit this sub-run's events (which carry the
       *  sub-agent's own `runId`, not the turn's) into the active turn's trace. */
      parentRunId: string;
      parentAgentId: string;
      agentId: string;
      role: string;
      /** The `delegateToSubAgent` tool call that spawned this sub-agent, so the
       *  UI can nest its live trace inside that tool call's expansion. */
      toolCallId?: string;
    }
  | { kind: 'sub-agent-finish'; runId: string; agentId: string; summary: string }
  | { kind: 'compaction-start'; runId: string; reason: CompactionReason }
  | {
      kind: 'compaction-end';
      runId: string;
      summaryEntryId: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { kind: 'entry-appended'; sessionId: string; entryId: string }
  /**
   * The session's execution mode changed (agent §3.8). Emitted on every
   * `setExecutionMode`, and on the implicit plan→ask/auto transition after a
   * plan is approved. Drives the host's mode indicator.
   */
  | { kind: 'mode-changed'; sessionId: string; mode: ExecutionMode }
  /**
   * The orchestrator called `exitPlanMode` (agent §3.8.4): the run is suspended
   * awaiting the user's decision. Hosts render the plan (editable) + the
   * pre-declared actions and reply with `approvePlan(planId, …)`. Same
   * disable-input-while-pending invariant as approval / askUserQuestion.
   */
  | {
      kind: 'plan-proposed';
      runId: string;
      agentId: string;
      parentAgentId?: string;
      /** Correlates the decision back to the suspended call (= the toolCallId). */
      planId: string;
      /** The proposed plan as markdown. */
      plan: string;
      /** High-risk actions the plan pre-declares; approval grants them (§3.8.4). */
      allowedActions?: PlanAllowedAction[];
    }
  | { kind: 'run-finish'; runId: string; finishReason: string }
  | { kind: 'error'; runId: string; message: string };

export type AgentStreamEventKind = AgentStreamEvent['kind'];

/** Listener registered by the host to receive the event stream. */
export type StreamListener = (event: AgentStreamEvent) => void;
