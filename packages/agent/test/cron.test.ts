/**
 * Cron / interval evaluation (§7) and the Scheduler tick/catch-up logic. Both are
 * pure given injected time, so no model/provider is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseCron, parseEvery, nextCronAfter, nextRunAfter } from '../src/schedules/cron.js';
import { Scheduler, type SchedulerDeps } from '../src/schedules/scheduler.js';
import type { ScheduleDef } from '../src/schedules/registry.js';
import type { ScheduleState } from '../src/storage/schedule-store.js';

/** Build a local-time epoch ms (avoids UTC/tz drift in assertions). */
const at = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe('cron parsing', () => {
  it('parses fields incl. star, step, range, list; rejects malformed', () => {
    expect(parseCron('0 9 * * *')).toBeTruthy();
    expect(parseCron('*/15 0-6 1,15 * 1-5')).toBeTruthy();
    expect(parseCron('60 0 * * *')).toBeUndefined(); // minute out of range
    expect(parseCron('0 0 * *')).toBeUndefined(); // too few fields
    expect(parseCron('a 0 * * *')).toBeUndefined(); // non-numeric
  });

  it('expands `N/step` from a numeric base up to max (not just the base)', () => {
    // Regression: `0/15` used to collapse to {0}; standard cron = {0,15,30,45}.
    expect([...parseCron('0/15 * * * *')!.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron('5/15 * * * *')!.minute].sort((a, b) => a - b)).toEqual([5, 20, 35, 50]);
    // A bare number with no step is still a single value.
    expect([...parseCron('7 * * * *')!.minute]).toEqual([7]);
    // `*/15` and range-with-step keep working.
    expect([...parseCron('*/15 * * * *')!.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it('fires `0/15` every 15 minutes, not only at :00', () => {
    expect(nextCronAfter('0/15 * * * *', at(2026, 6, 24, 9, 1))).toBe(at(2026, 6, 24, 9, 15));
    expect(nextCronAfter('0/15 * * * *', at(2026, 6, 24, 9, 20))).toBe(at(2026, 6, 24, 9, 30));
  });

  it('parseEvery handles n + unit; rejects junk', () => {
    expect(parseEvery('30m')).toBe(30 * 60_000);
    expect(parseEvery('6h')).toBe(6 * 3_600_000);
    expect(parseEvery('1d')).toBe(86_400_000);
    expect(parseEvery('0m')).toBeUndefined();
    expect(parseEvery('5x')).toBeUndefined();
  });
});

describe('nextCronAfter', () => {
  it('finds the next daily 09:00 strictly after `from`', () => {
    // from 2026-06-24 08:30 → same day 09:00
    expect(nextCronAfter('0 9 * * *', at(2026, 6, 24, 8, 30))).toBe(at(2026, 6, 24, 9, 0));
    // from 2026-06-24 09:00 → next day 09:00 (strictly after)
    expect(nextCronAfter('0 9 * * *', at(2026, 6, 24, 9, 0))).toBe(at(2026, 6, 25, 9, 0));
  });

  it('honors day-of-week (Mon 09:00)', () => {
    // 2026-06-24 is a Wednesday → next Monday is 2026-06-29
    expect(nextCronAfter('0 9 * * 1', at(2026, 6, 24, 12, 0))).toBe(at(2026, 6, 29, 9, 0));
  });

  it('nextRunAfter uses `every` when no cron', () => {
    expect(nextRunAfter({ every: '1h' }, 1_000)).toBe(1_000 + 3_600_000);
    expect(nextRunAfter({}, 1_000)).toBeUndefined(); // manual-only
  });
});

/** A fake scheduler backend recording fires + state, with controllable time. */
function fakeDeps(defs: ScheduleDef[], nowRef: { v: number }) {
  const state = new Map<string, ScheduleState>();
  const fired: string[] = [];
  const deps: SchedulerDeps = {
    now: () => nowRef.v,
    list: () => defs,
    getState: (n) => state.get(n),
    putState: (s) => state.set(s.name, { ...state.get(s.name), ...s }),
    fire: async (n) => {
      fired.push(n);
    },
  };
  return { deps, state, fired };
}

const def = (over: Partial<ScheduleDef>): ScheduleDef => ({
  name: 'x',
  mode: 'auto',
  session: { kind: 'fresh' },
  onMissed: 'run-once',
  enabled: true,
  goal: 'do it',
  dir: '/tmp',
  ...over,
});

describe('Scheduler.tick', () => {
  it('arms a newly-seen schedule WITHOUT firing it', async () => {
    const now = { v: at(2026, 6, 24, 8, 0) };
    const d = def({ name: 'daily', cron: '0 9 * * *' });
    const { deps, state, fired } = fakeDeps([d], now);
    const s = new Scheduler(deps);
    await s.tick();
    expect(fired).toEqual([]); // first sight → arm, don't fire
    expect(state.get('daily')!.nextRunAt).toBe(at(2026, 6, 24, 9, 0));
  });

  it('fires when due and advances to the next slot', async () => {
    const now = { v: at(2026, 6, 24, 8, 0) };
    const d = def({ name: 'daily', cron: '0 9 * * *' });
    const { deps, state, fired } = fakeDeps([d], now);
    const s = new Scheduler(deps);
    await s.tick(); // arm → nextRunAt = 09:00
    now.v = at(2026, 6, 24, 9, 0); // time advances to due
    await s.tick();
    expect(fired).toEqual(['daily']);
    expect(state.get('daily')!.nextRunAt).toBe(at(2026, 6, 25, 9, 0)); // advanced
  });

  it('catch-up: a window missed while down fires exactly once', async () => {
    const now = { v: at(2026, 6, 24, 23, 0) };
    const d = def({ name: 'daily', cron: '0 9 * * *' });
    const { deps, state, fired } = fakeDeps([d], now);
    // Simulate prior state armed for a now-missed 09:00.
    state.set('daily', { name: 'daily', nextRunAt: at(2026, 6, 24, 9, 0) });
    const s = new Scheduler(deps);
    await s.tick();
    expect(fired).toEqual(['daily']); // fired once for the missed window
    expect(state.get('daily')!.nextRunAt).toBe(at(2026, 6, 25, 9, 0)); // jumped to future
    fired.length = 0;
    await s.tick(); // not due again
    expect(fired).toEqual([]);
  });

  it('skips disabled and manual-only (no cron/every) schedules', async () => {
    const now = { v: at(2026, 6, 24, 9, 0) };
    const off = def({ name: 'off', cron: '0 9 * * *', enabled: false });
    const manual = def({ name: 'manual' }); // no cron/every
    const { deps, fired, state } = fakeDeps([off, manual], now);
    const s = new Scheduler(deps);
    await s.tick();
    await s.tick();
    expect(fired).toEqual([]);
    expect(state.get('off')).toBeUndefined();
    expect(state.get('manual')).toBeUndefined();
  });

  it('on-missed: skip — a missed window is re-armed without firing', async () => {
    const now = { v: at(2026, 6, 24, 23, 0) }; // hours past the 09:00 window
    const d = def({ name: 'digest', cron: '0 9 * * *', onMissed: 'skip' });
    const { deps, state, fired } = fakeDeps([d], now);
    state.set('digest', { name: 'digest', nextRunAt: at(2026, 6, 24, 9, 0) }); // stale
    const s = new Scheduler(deps);
    await s.tick();
    expect(fired).toEqual([]); // missed → skipped, not fired
    expect(state.get('digest')!.nextRunAt).toBe(at(2026, 6, 25, 9, 0)); // re-armed to future
  });

  it('on-missed: skip — an ON-TIME fire still runs (only stale windows skip)', async () => {
    const now = { v: at(2026, 6, 24, 9, 0) };
    const d = def({ name: 'digest', cron: '0 9 * * *', onMissed: 'skip' });
    const { deps, state, fired } = fakeDeps([d], now);
    state.set('digest', { name: 'digest', nextRunAt: at(2026, 6, 24, 9, 0) }); // due right now
    const s = new Scheduler(deps);
    await s.tick();
    expect(fired).toEqual(['digest']); // within grace → on-time → fires
  });

  it('a throwing fire does not wedge the tick; it advances anyway', async () => {
    const now = { v: at(2026, 6, 24, 9, 0) };
    const d = def({ name: 'daily', cron: '0 9 * * *' });
    const { deps, state } = fakeDeps([d], now);
    state.set('daily', { name: 'daily', nextRunAt: at(2026, 6, 24, 9, 0) });
    deps.fire = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = new Scheduler(deps);
    await s.tick();
    expect(state.get('daily')!.nextRunAt).toBe(at(2026, 6, 25, 9, 0)); // still advanced
  });
});
