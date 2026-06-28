/**
 * Usage analytics ledger (agent §2.7). One append-only fact per model call —
 * the atomic record from which every reporting dimension (per message / agent /
 * model / system-overhead / hour / day / month / …) is a group-by projection.
 * Stored as month-partitioned JSONL under `~/.enterprise-agent/usage/`.
 */
import type { TokenUsage } from './events.js';

/**
 * Category of a model call — the "system overhead vs real inference" split.
 * `orchestrator`/`sub-agent` are conversational; the rest are the agent's own
 * auxiliary calls (compaction summary, auto-mode classifier, title generation).
 */
export type UsageCategory =
  | 'orchestrator'
  | 'sub-agent'
  | 'compaction'
  | 'classifier'
  | 'title';

/** One atomic model-call usage fact — a line in a `usage/<YYYY-MM>.jsonl` file. */
export interface UsageEvent {
  /** Epoch ms of the call — buckets into hour/day/month at query time. */
  ts: number;
  sessionId: string;
  runId: string;
  /** `orch` | `sub-…` | `system:compaction|classifier|title`. */
  agentId: string;
  /** `provider:model`. */
  modelRef: string;
  /** Provider id (the `modelRef` prefix), denormalized for grouping. */
  provider: string;
  category: UsageCategory;
  /**
   * The session-tree entry this call contributed to (per-message dimension).
   * Set for orchestrator turns; omitted for sub-agent/auxiliary calls that don't
   * map to a single conversational message.
   */
  entryId?: string;
  usage: TokenUsage;
  /** Cost in USD frozen at write time (prices change; reports must be stable). */
  cost: number;
}

/** A groupable dimension for a usage query (`hour`/`day`/`month` are ts buckets). */
export type UsageDimension =
  | 'sessionId'
  | 'runId'
  | 'agentId'
  | 'modelRef'
  | 'provider'
  | 'category'
  | 'entryId'
  | 'hour'
  | 'day'
  | 'month';

/** A multi-dimensional rollup request over the ledger (agent §2.7). */
export interface UsageQuery {
  /** Inclusive lower bound (epoch ms); omit for "from the beginning". */
  from?: number;
  /** Exclusive upper bound (epoch ms); omit for "until now". */
  to?: number;
  /** Equality filters applied before grouping. */
  filter?: Partial<Record<'sessionId' | 'agentId' | 'modelRef' | 'provider' | 'category', string>>;
  /** Dimensions to group by; an empty array yields a single grand-total row. */
  groupBy: UsageDimension[];
}

/** One aggregated row: the group key plus summed metrics. */
export interface UsageRollup {
  /** The grouped dimension values (time buckets are local-tz strings). */
  key: Partial<Record<UsageDimension, string>>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cost: number;
  /** Number of model calls in this group. */
  calls: number;
}
