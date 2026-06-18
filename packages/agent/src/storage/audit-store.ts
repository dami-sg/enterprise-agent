/**
 * Audit log (agent §5.2 / §3.3): append-only `audit.jsonl` of every tool call
 * and approval decision, retraceable (grant key, agentScoped, approval mode).
 */
import type { AuditRecord } from '@enterprise-agent/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';

export class AuditStore {
  constructor(private readonly file: string) {}

  record(rec: Omit<AuditRecord, 'ts'>): void {
    appendJsonl(this.file, { ...rec, ts: Date.now() } satisfies AuditRecord);
  }

  all(): AuditRecord[] {
    return readJsonl<AuditRecord>(this.file);
  }
}
