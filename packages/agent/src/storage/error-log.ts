/**
 * Error log (observability §2): append-only `logs/errors.jsonl` of every
 * `kind:'error'` stream event plus process-level fatals (§3), so a crash is
 * retraceable after the process is gone. Same crash-safe append/read as the
 * audit + run stores (agent §5.3); global rather than per-session because MCP
 * (`runId='mcp'`) and process errors don't always map to a session.
 */
import type { ErrorRecord } from '@dami-sg/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';
import { redact } from '../util/redact.js';

export class ErrorLog {
  constructor(private readonly file: string) {}

  /** Append one error. `message`/`stack` are redacted (§9) before they land. */
  record(rec: Omit<ErrorRecord, 'ts'> & { ts?: number }): void {
    const safe: ErrorRecord = {
      ...rec,
      ts: rec.ts ?? Date.now(),
      message: redact(rec.message),
      stack: rec.stack ? redact(rec.stack) : undefined,
    };
    appendJsonl(this.file, safe);
  }

  all(): ErrorRecord[] {
    return readJsonl<ErrorRecord>(this.file);
  }

  /** Most recent `n` records (for `doctor` §7 and the gateway panel). */
  recent(n: number): ErrorRecord[] {
    const all = this.all();
    return all.slice(Math.max(0, all.length - n));
  }
}
