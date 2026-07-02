/**
 * Append-only session tree (agent §5.3 / §5.4). `session.jsonl` is folded into
 * an entry tree + current head + labels. Fork / label / compaction are all
 * appends — old state is never rewritten, so branches survive.
 */
import type {
  Entry,
  SessionRecord,
  SummaryInfo,
  MessagePart,
  EntryKind,
  EntryUsage,
} from '@enterprise-agent/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';
import { redact } from '../util/redact.js';

let counter = 0;
/** Monotonic, collision-resistant id (avoids Date.now/Math.random determinism issues). */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${process.hrtime.bigint().toString(36)}${counter.toString(36)}`;
}

export interface FoldedSession {
  entries: Map<string, Entry>;
  children: Map<string, string[]>;
  labels: Map<string, string>;
  headId?: string;
  rootId?: string;
}

export class SessionStore {
  private folded: FoldedSession;

  constructor(private readonly file: string) {
    this.folded = this.fold();
  }

  /** Re-read the log from disk (e.g. after external append). */
  reload(): void {
    this.folded = this.fold();
  }

  private fold(): FoldedSession {
    const records = readJsonl<SessionRecord>(this.file);
    const entries = new Map<string, Entry>();
    const children = new Map<string, string[]>();
    const labels = new Map<string, string>();
    let headId: string | undefined;
    let rootId: string | undefined;

    for (const r of records) {
      if (r.type === 'entry') {
        entries.set(r.id, r);
        if (!r.parentId) rootId ??= r.id;
        else {
          const arr = children.get(r.parentId) ?? [];
          arr.push(r.id);
          children.set(r.parentId, arr);
        }
        headId = r.id; // default head follows last appended entry
      } else if (r.type === 'head') {
        headId = r.entryId;
      } else if (r.type === 'label') {
        labels.set(r.entryId, r.label);
      }
    }
    return { entries, children, labels, headId, rootId };
  }

  get headId(): string | undefined {
    return this.folded.headId;
  }

  getEntry(id: string): Entry | undefined {
    return this.folded.entries.get(id);
  }

  getChildren(id: string): Entry[] {
    // An orphaned child id (present in `children` but not `entries`, e.g. a
    // truncated/corrupt jsonl) resolves to undefined and is dropped — no crash,
    // and the type stays honest (no non-null assertion hiding the possibility).
    return (this.folded.children.get(id) ?? [])
      .map((c) => this.folded.entries.get(c))
      .filter((e): e is Entry => e !== undefined);
  }

  /**
   * Active context path: from a head back to root, OR to the nearest summary
   * ancestor (inclusive) — the compaction baseline (agent §5.4 / §5.5).
   */
  getPath(headId?: string): Entry[] {
    const start = headId ?? this.folded.headId;
    if (!start) return [];
    const chain: Entry[] = [];
    let cur: string | undefined = start;
    while (cur) {
      const e = this.folded.entries.get(cur);
      if (!e) break;
      chain.push(e);
      if (e.kind === 'summary') break; // stop at compaction baseline
      cur = e.parentId;
    }
    return chain.reverse();
  }

  /** Full tree for UI navigation (agent §5.4). */
  getTree(): { nodes: Record<string, Entry>; labels: Record<string, string>; rootId?: string; headId?: string } {
    return {
      nodes: Object.fromEntries(this.folded.entries),
      labels: Object.fromEntries(this.folded.labels),
      rootId: this.folded.rootId,
      headId: this.folded.headId,
    };
  }

  // -- mutations (all append-only) --

  appendEntry(
    input: {
      parentId?: string;
      runId?: string;
      agentId?: string;
      kind: EntryKind;
      content?: MessagePart[];
      summary?: SummaryInfo;
      usage?: EntryUsage;
    },
    opts: { moveHead?: boolean } = {},
  ): Entry {
    const moveHead = opts.moveHead ?? true;
    // Message parts carry tool-call arguments and tool results, which routinely
    // hold credentials (auth headers, tokens). Redact once so neither the on-disk
    // replay log (session.jsonl) nor the in-memory fold — and thus the history
    // rebuilt for the model — ever retains a raw secret (redact.ts).
    const entry: Entry = {
      type: 'entry',
      id: newId('e'),
      parentId: input.parentId ?? this.folded.headId,
      runId: input.runId,
      agentId: input.agentId,
      kind: input.kind,
      content: input.content ? redact(input.content) : input.content,
      summary: input.summary ? redact(input.summary) : input.summary,
      usage: input.usage,
      ts: Date.now(),
    };
    appendJsonl(this.file, entry);
    // update in-memory fold
    this.folded.entries.set(entry.id, entry);
    if (!entry.parentId) this.folded.rootId ??= entry.id;
    else {
      const arr = this.folded.children.get(entry.parentId) ?? [];
      arr.push(entry.id);
      this.folded.children.set(entry.parentId, arr);
    }
    // Sub-agent transcripts hang off their delegate entry without moving the
    // active head, so they never pollute the main session path (agent §5.6).
    if (moveHead) this.setHead(entry.id);
    return entry;
  }

  setHead(entryId: string): void {
    appendJsonl(this.file, { type: 'head', entryId });
    this.folded.headId = entryId;
  }

  label(entryId: string, label: string): void {
    appendJsonl(this.file, { type: 'label', entryId, label });
    this.folded.labels.set(entryId, label);
  }

  /** Fork: branch off an existing entry by pointing head there (agent §5.4). */
  fork(entryId: string): void {
    if (!this.folded.entries.has(entryId)) {
      throw new Error(`cannot fork from unknown entry ${entryId}`);
    }
    this.setHead(entryId);
  }
}
