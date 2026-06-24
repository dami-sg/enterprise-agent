/**
 * Scheduler (§7 定时编排). Drives schedule firing: on each `tick` it evaluates
 * every enabled schedule, fires those that are due, and advances `nextRunAt` to
 * the next future slot. Durable across restarts via the injected state store —
 * no external workflow engine.
 *
 * Dependencies are injected (not imported) so the tick/catch-up logic is unit-
 * testable with a fake `fire`, and so the core's AgentHost can wire the real
 * session-firing path without an import cycle. The host owns the wall-clock timer
 * (start/stop); a long-running host (the gateway) keeps it ticking.
 */
import type { ScheduleDef } from './registry.js';
import type { ScheduleState } from '../storage/schedule-store.js';
import { nextRunAfter } from './cron.js';

export interface SchedulerDeps {
  /** Current epoch ms (injected for determinism in tests). */
  now(): number;
  /** All schedule definitions (the host re-discovers fresh each call). */
  list(): ScheduleDef[];
  getState(name: string): ScheduleState | undefined;
  putState(state: ScheduleState): void;
  /** Fire a schedule (delegates to the host's runScheduleNow). */
  fire(name: string): Promise<void>;
  /** Optional progress line. */
  log?(message: string): void;
}

export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  /** Tick cadence; used to tell an on-time fire from a missed window (B.4). */
  private tickIntervalMs = 60_000;

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * A due fire is "missed" (vs on-time) when `now` is later than its scheduled
   * `nextRunAt` by more than one tick plus slack — i.e. it could only be this late
   * because the host wasn't ticking (was down). A normal slightly-late tick stays
   * "on-time" and always fires.
   */
  private isMissed(nextRunAt: number, now: number): boolean {
    return now - nextRunAt > this.tickIntervalMs + 120_000;
  }

  /**
   * Evaluate all enabled schedules once. A schedule first seen (no `nextRunAt`
   * state) is ARMED for its next future slot WITHOUT firing — so adding a
   * SCHEDULE.md never triggers an immediate run. A due schedule fires, then
   * advances; because `nextRunAfter(now)` jumps strictly past `now`, a window
   * missed while the host was down fires exactly once (catch-up run-once), never
   * a backlog storm. Re-entrant ticks are skipped so a slow fire can't overlap.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.deps.now();
      for (const def of this.deps.list()) {
        if (!def.enabled) continue;
        const armed = nextRunAfter(def, now);
        if (armed === undefined) continue; // manual-only (no/invalid cron + every)

        const state = this.deps.getState(def.name);
        if (state?.nextRunAt === undefined) {
          this.deps.putState({ name: def.name, nextRunAt: armed });
          continue;
        }
        if (state.nextRunAt > now) continue; // not due yet

        // Missed window + `on-missed: skip` → don't fire a stale run; just re-arm
        // to the next future slot (B.4). Default `run-once` falls through and fires.
        if (def.onMissed === 'skip' && this.isMissed(state.nextRunAt, now)) {
          this.deps.log?.(`schedule '${def.name}' missed its window — skipped (on-missed: skip)`);
          this.deps.putState({ name: def.name, nextRunAt: nextRunAfter(def, now) });
          continue;
        }

        this.deps.log?.(`schedule '${def.name}' due — firing`);
        try {
          await this.deps.fire(def.name);
        } catch {
          // fire() records its own error status; keep advancing so a failing
          // schedule doesn't wedge the tick or re-fire every tick.
        }
        const next = nextRunAfter(def, this.deps.now());
        this.deps.putState({ name: def.name, nextRunAt: next });
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Start the wall-clock timer (default every 60s). Idempotent. */
  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.tickIntervalMs = intervalMs;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Don't keep the process alive just for the scheduler (the gateway's server
    // socket is what should hold it open).
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the wall-clock timer. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
