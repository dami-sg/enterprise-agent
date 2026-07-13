/**
 * Run tree (agent §5.0 / §5.6): `runs.jsonl`, one line per run, linked by
 * `parentRunId`. Drives the run-trace tree (main → sub agent delegation).
 */
import type { RunRecord } from '@dami-sg/agent-contract';
import { appendJsonl, readJsonl } from '../util/fs.js';
import { newId } from './session-store.js';

export class RunStore {
  private runs = new Map<string, RunRecord>();

  constructor(private readonly file: string) {
    for (const r of readJsonl<RunRecord>(this.file)) this.runs.set(r.id, r);
  }

  start(input: { id?: string; parentRunId?: string; rootEntryId?: string; agentId: string }): RunRecord {
    const run: RunRecord = {
      // Callers that must return a runId synchronously before the run body runs
      // (Session's serialized turn queue) pre-allocate the id and pass it here.
      id: input.id ?? newId('r'),
      parentRunId: input.parentRunId,
      rootEntryId: input.rootEntryId,
      agentId: input.agentId,
      status: 'running',
      startedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    appendJsonl(this.file, run);
    return run;
  }

  finish(runId: string, status: RunRecord['status'], finishReason?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const updated: RunRecord = { ...run, status, finishReason, endedAt: Date.now() };
    this.runs.set(runId, updated);
    appendJsonl(this.file, updated);
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  all(): RunRecord[] {
    return [...this.runs.values()];
  }
}
