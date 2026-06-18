/**
 * On-disk persistence shapes (agent §5): append-only session tree, run tree,
 * and audit log. These types describe the JSONL line records.
 */

/** A v6 message part (UIMessage / ModelMessage). Kept opaque at the contract level. */
export type MessagePart = Record<string, unknown>;

export type EntryKind = 'user' | 'assistant' | 'tool_result' | 'summary';

/** Reason a compaction checkpoint was created (agent §5.5). */
export type CompactionReason = 'manual' | 'threshold' | 'overflow';

export interface SummaryInfo {
  reason: CompactionReason;
  firstKeptEntryId: string;
  tokensBefore: number;
  tokensAfter: number;
}

export interface EntryUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

/** A node in the session tree (agent §5.0 / §5.3). */
export interface Entry {
  type: 'entry';
  id: string;
  parentId?: string;
  runId?: string;
  agentId?: string;
  kind: EntryKind;
  content?: MessagePart[];
  /** For `kind: 'summary'` entries. */
  summary?: SummaryInfo;
  usage?: EntryUsage;
  ts: number;
}

export interface LabelRecord {
  type: 'label';
  entryId: string;
  label: string;
}

export interface HeadRecord {
  type: 'head';
  entryId: string;
}

/** One line of `session.jsonl`. */
export type SessionRecord = Entry | LabelRecord | HeadRecord;

/** One line of `runs.jsonl` (run tree, agent §5.0). */
export interface RunRecord {
  id: string;
  parentRunId?: string;
  rootEntryId?: string;
  agentId: string;
  status: 'running' | 'done' | 'aborted' | 'error';
  startedAt: number;
  endedAt?: number;
  finishReason?: string;
}

/** One line of `audit.jsonl` (agent §5.2 / §3.3). */
export interface AuditRecord {
  ts: number;
  runId: string;
  agentId: string;
  toolCallId: string;
  tool: string;
  input: unknown;
  output?: unknown;
  /** 'once' | 'task' | 'reject' | 'task-auto' | 'auto' | 'denied-policy'. */
  approval: string;
  grantKey?: string;
  agentScoped?: boolean;
}
