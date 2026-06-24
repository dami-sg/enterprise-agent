/**
 * Schedule run state (§7 定时编排). Append-only `schedules-state.jsonl`, one line
 * per state write, keyed by schedule `name` (latest line wins). This is the durable
 * substrate: on restart the scheduler reloads it and recomputes the next fire time
 * from the cron expression (B-P2) — no external workflow engine, consistent with
 * the file-over-SQLite stance (agent §5.7). Mirrors RunStore.
 */
import { appendJsonl, readJsonl } from '../util/fs.js';

export interface ScheduleState {
  /** Schedule name (the ScheduleDef.name). */
  name: string;
  /** Epoch ms of the last fire start; undefined if never run. */
  lastRunAt?: number;
  /** runId of the last fire (for trace lookup). */
  lastRunId?: string;
  /** Outcome of the last fire. */
  lastStatus?: 'done' | 'error' | 'skipped';
  /** Epoch ms of the next scheduled fire (computed from cron by the scheduler). */
  nextRunAt?: number;
}

export class ScheduleStore {
  private states = new Map<string, ScheduleState>();

  constructor(private readonly file: string) {
    // Replay the log; later lines for a name overwrite earlier ones.
    for (const s of readJsonl<ScheduleState>(this.file)) this.states.set(s.name, s);
  }

  get(name: string): ScheduleState | undefined {
    return this.states.get(name);
  }

  all(): ScheduleState[] {
    return [...this.states.values()];
  }

  /** Persist a state record (merged over any prior state for the same name). */
  put(state: ScheduleState): void {
    const merged = { ...this.states.get(state.name), ...state };
    this.states.set(state.name, merged);
    appendJsonl(this.file, merged);
  }
}
