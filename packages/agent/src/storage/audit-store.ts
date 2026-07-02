/**
 * Audit log (agent §5.2 / §3.3): append-only `audit.jsonl` of every tool call
 * and approval decision, retraceable (grant key, agentScoped, approval mode).
 */
import type { AuditRecord } from '@enterprise-agent/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';
import { redact } from '../util/redact.js';

export class AuditStore {
  constructor(private readonly file: string) {}

  record(rec: Omit<AuditRecord, 'ts'>): void {
    // The audit log deliberately captures tool `input`/`output`, which routinely
    // carry credentials (auth headers, tokens the model passed to a tool). Redact
    // on the way out so the standing "secrets never reach a log" invariant holds
    // for this sink too (redact.ts) — symmetric to ErrorLog.
    appendJsonl(this.file, redact({ ...rec, ts: Date.now() } satisfies AuditRecord));
  }

  all(): AuditRecord[] {
    return readJsonl<AuditRecord>(this.file);
  }
}
