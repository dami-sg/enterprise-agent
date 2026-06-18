/**
 * Stream events (agent §6.2): module → host, one-directional streaming.
 * Hosts merge by `agentId` / `parentAgentId` into a run trace tree.
 */
import type { Todo } from './domain.js';
import type { CompactionReason } from './storage.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export type AgentStreamEvent =
  | { kind: 'text-delta'; runId: string; agentId: string; text: string }
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
      usage: TokenUsage;
      totalUsage: TokenUsage;
      cost: number;
    }
  | { kind: 'todo-update'; workId: string; todos: Todo[] }
  | {
      kind: 'sub-agent-start';
      runId: string;
      parentAgentId: string;
      agentId: string;
      role: string;
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
  | { kind: 'run-finish'; runId: string; finishReason: string }
  | { kind: 'error'; runId: string; message: string };

export type AgentStreamEventKind = AgentStreamEvent['kind'];

/** Listener registered by the host to receive the event stream. */
export type Streamlistener = (event: AgentStreamEvent) => void;
