/**
 * Usage analytics ledger (agent §2.7). Append-only, month-partitioned JSONL:
 * one `UsageEvent` per model call under `~/.enterprise-agent/usage/<YYYY-MM>.jsonl`.
 * This is the analytical source of truth — every reporting dimension (per
 * message / agent / model / system-overhead / hour / day / month / …) is a
 * group-by projection of these facts, computed by streaming the partitions.
 *
 * `session.json.usage` (RegistryStore) stays the live per-session snapshot for
 * the running UI; this is the durable, queryable history beside it.
 */
import type {
  UsageDimension,
  UsageEvent,
  UsageQuery,
  UsageRollup,
} from '@dami-sg/agent-contract';
import { join } from 'node:path';
import { appendJsonl, listFiles, readJsonl } from '../util/fs.js';

/** Local-tz `YYYY-MM` for `ts` — the partition file an event lands in. */
export function partitionOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local-tz bucket label for a time dimension. */
function timeBucket(ts: number, dim: 'hour' | 'day' | 'month'): string {
  const d = new Date(ts);
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dim === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (dim === 'day') return ymd;
  return `${ymd} ${pad(d.getHours())}:00`;
}

/** Value of one (non-time) dimension on an event. */
function dimValue(ev: UsageEvent, dim: UsageDimension): string {
  switch (dim) {
    case 'hour':
    case 'day':
    case 'month':
      return timeBucket(ev.ts, dim);
    case 'entryId':
      return ev.entryId ?? '(none)';
    default:
      return String(ev[dim] ?? '');
  }
}

export class UsageLedger {
  constructor(private readonly dir: string) {}

  /** Append one usage fact to its month partition (agent §2.7). */
  append(ev: UsageEvent): void {
    appendJsonl(join(this.dir, `${partitionOf(ev.ts)}.jsonl`), ev);
  }

  /** All partition month labels present on disk, ascending. */
  partitions(): string[] {
    return listFiles(this.dir, '.jsonl')
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort();
  }

  /**
   * Stream the partitions overlapping `[from, to]` and aggregate by `groupBy`
   * (agent §2.7). Time dimensions bucket in local tz. Returns rows sorted by
   * descending cost so the biggest spenders surface first.
   */
  query(q: UsageQuery): UsageRollup[] {
    const fromMonth = q.from != null ? partitionOf(q.from) : undefined;
    const toMonth = q.to != null ? partitionOf(q.to) : undefined;
    const rows = new Map<string, UsageRollup>();

    for (const month of this.partitions()) {
      if (fromMonth && month < fromMonth) continue;
      if (toMonth && month > toMonth) continue;
      for (const ev of readJsonl<UsageEvent>(join(this.dir, `${month}.jsonl`))) {
        if (q.from != null && ev.ts < q.from) continue;
        if (q.to != null && ev.ts >= q.to) continue;
        if (!matchesFilter(ev, q.filter)) continue;
        accumulate(rows, ev, q.groupBy);
      }
    }
    return [...rows.values()].sort((a, b) => b.cost - a.cost);
  }
}

function matchesFilter(ev: UsageEvent, filter: UsageQuery['filter']): boolean {
  if (!filter) return true;
  for (const [k, v] of Object.entries(filter)) {
    if (v != null && String(ev[k as keyof UsageEvent]) !== v) return false;
  }
  return true;
}

function accumulate(rows: Map<string, UsageRollup>, ev: UsageEvent, groupBy: UsageDimension[]): void {
  const key: Partial<Record<UsageDimension, string>> = {};
  for (const dim of groupBy) key[dim] = dimValue(ev, dim);
  // NUL-join the dimension values: a separator that can't appear in any value
  // (time buckets like "2026-06-28 10:00" contain spaces), so distinct group
  // keys never collide. Keep it as the `\0` escape, NOT a raw NUL byte — a raw
  // byte makes git treat this source as binary and hides its diffs from review.
  const id = groupBy.map((d) => key[d]).join('\0');

  let row = rows.get(id);
  if (!row) {
    row = {
      key,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cost: 0,
      calls: 0,
    };
    rows.set(id, row);
  }
  row.inputTokens += ev.usage.inputTokens ?? 0;
  row.outputTokens += ev.usage.outputTokens ?? 0;
  row.totalTokens += ev.usage.totalTokens ?? 0;
  row.reasoningTokens += ev.usage.reasoningTokens ?? 0;
  row.cachedInputTokens += ev.usage.cachedInputTokens ?? 0;
  row.cost += ev.cost;
  row.calls += 1;
}
