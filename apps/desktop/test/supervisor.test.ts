/**
 * SidecarSupervisor state machine (desktop-app §4.3/§4.5): adoption, crash
 * auto-restart with backoff, the crash-loop fuse, stale, manual-stop respect,
 * and version alignment — all against an injected fake manager/clock.
 */
import { describe, expect, it } from 'vitest';
import { SidecarSupervisor, type ProcessManagerLike } from '../src/main/supervisor.js';
import type { GatewaySnapshot } from '../src/shared/ipc.js';

type Status = ReturnType<ProcessManagerLike['status']>;

function harness(opts: { bundledVersion?: string } = {}) {
  let now = 100_000;
  let status: Status = { state: 'stopped' };
  const calls: string[] = [];
  const snaps: GatewaySnapshot[] = [];
  const manager: ProcessManagerLike = {
    status: () => status,
    start: () => {
      calls.push('start');
      status = { state: 'running', pid: 42, startedAt: now, rpcUrl: 'ws://127.0.0.1:7320/rpc', version: '9.9.9' };
    },
    stop: () => {
      calls.push('stop');
      status = { state: 'stopped' };
    },
  };
  const sup = new SidecarSupervisor({
    manager,
    bundledVersion: opts.bundledVersion,
    backoffMs: [1000, 5000, 30_000],
    crashLoopLimit: 3,
    stableMs: 60_000,
    now: () => now,
    // restart()'s wait-for-exit: the fake old process dies as soon as stop() ran.
    isAlive: () => status.state === 'running',
    killHard: () => {
      status = { state: 'stopped' };
    },
    sleep: async () => {
      now += 100;
    },
    onSnapshot: (s) => snaps.push(s),
  });
  return {
    sup,
    calls,
    snaps,
    advance: (ms: number) => {
      now += ms;
    },
    crash: () => {
      status = { state: 'error', pid: 42, startedAt: now, detail: 'boom', version: '9.9.9' };
    },
    setStatus: (s: Status) => {
      status = s;
    },
  };
}

describe('adoption (§4.1)', () => {
  it('adopts an already-running gateway without spawning', () => {
    const h = harness();
    h.setStatus({ state: 'running', pid: 7, startedAt: 1, rpcUrl: 'ws://x/rpc' });
    expect(h.sup.tick().state).toBe('running');
    expect(h.calls).toEqual([]);
  });
});

describe('crash auto-restart (§4.3)', () => {
  it('restarts after backoff, escalating 1s → 5s → 30s', () => {
    const h = harness();
    h.sup.start();
    expect(h.calls).toEqual(['start']);

    // Crash 1: scheduled at +1s, not before.
    h.crash();
    h.sup.tick();
    h.advance(999);
    h.sup.tick();
    expect(h.calls).toEqual(['start']);
    h.advance(1);
    h.sup.tick();
    expect(h.calls).toEqual(['start', 'start']);

    // Crash 2 (within the streak): +5s.
    h.crash();
    h.sup.tick();
    h.advance(4999);
    h.sup.tick();
    expect(h.calls).toHaveLength(2);
    h.advance(1);
    h.sup.tick();
    expect(h.calls).toHaveLength(3);
  });

  it('fuses after crashLoopLimit consecutive crashes; manual restart re-arms', async () => {
    const h = harness();
    h.sup.start();
    for (const delay of [1000, 5000, 30_000]) {
      h.crash();
      h.sup.tick(); // schedule
      h.advance(delay);
      h.sup.tick(); // restart
    }
    expect(h.calls.filter((c) => c === 'start')).toHaveLength(4);

    // 4th crash → fuse: no further auto-restarts, ever.
    h.crash();
    h.sup.tick();
    expect(h.sup.snapshot().autoRestart).toBe('fused');
    h.advance(120_000);
    h.sup.tick();
    expect(h.calls.filter((c) => c === 'start')).toHaveLength(4);

    // Manual restart clears the fuse and the crash count.
    await h.sup.restart();
    expect(h.sup.snapshot().autoRestart).toBe('armed');
    expect(h.sup.snapshot().crashCount).toBe(0);
  });

  it('a stable run ends the crash streak', () => {
    const h = harness();
    h.sup.start();
    h.crash();
    h.sup.tick();
    h.advance(1000);
    h.sup.tick(); // restarted, crashCount=1
    h.advance(60_000); // stable uptime
    h.sup.tick();
    expect(h.sup.snapshot().crashCount).toBe(0);
  });

  it('does NOT auto-restart after a deliberate stop (§4.4)', () => {
    const h = harness();
    h.sup.start();
    h.sup.stop();
    h.advance(60_000);
    h.sup.tick();
    expect(h.calls).toEqual(['start', 'stop']);
    expect(h.sup.snapshot().state).toBe('stopped');
  });
});

describe('stale & restarting (§4.3)', () => {
  it('markStale sets the flag; restart clears it', async () => {
    const h = harness();
    h.sup.start();
    h.sup.markStale();
    expect(h.sup.snapshot().stale).toBe(true);
    await h.sup.restart();
    expect(h.sup.snapshot().stale).toBe(false);
  });

  it('restart hard-kills an old process that ignores SIGTERM before respawning', async () => {
    let now = 0;
    let alivePid: number | undefined = 77;
    const calls: string[] = [];
    const stubborn: ProcessManagerLike = {
      status: () =>
        alivePid !== undefined ? { state: 'running', pid: alivePid, startedAt: 0 } : { state: 'stopped' },
      start: () => {
        calls.push('start');
        alivePid = 88;
      },
      stop: () => {
        calls.push('stop'); // SIGTERM sent but the fake process stays alive
      },
    };
    const sup = new SidecarSupervisor({
      manager: stubborn,
      stopGraceMs: 1000,
      now: () => now,
      isAlive: (pid) => pid === alivePid,
      killHard: (pid) => {
        calls.push(`kill9:${pid}`);
        if (pid === alivePid) alivePid = undefined;
      },
      sleep: async (ms) => {
        now += ms;
      },
    });
    await sup.restart();
    expect(calls).toEqual(['stop', 'kill9:77', 'start']);
  });

  it('reports restarting until /rpc is observed', () => {
    const h = harness();
    // Manager whose start() has no rpcUrl yet (panel-style optimistic pre-write).
    h.setStatus({ state: 'stopped' });
    const noRpc: ProcessManagerLike = {
      status: () => ({ state: 'running', pid: 1, startedAt: 0 }),
      start: () => {},
      stop: () => {},
    };
    let now = 0;
    const sup = new SidecarSupervisor({ manager: noRpc, now: () => now });
    sup.start();
    expect(sup.snapshot().restarting).toBe(true);
    now += 31_000; // timeout clears it even without rpcUrl
    expect(sup.snapshot().restarting).toBe(false);
  });
});

describe('version alignment (§4.5)', () => {
  it('flags mismatch when running version differs from bundled', () => {
    const h = harness({ bundledVersion: '1.0.0' });
    h.sup.start(); // manager reports version 9.9.9
    expect(h.sup.tick().versionMismatch).toBe(true);
  });

  it('no mismatch when equal, or when no bundled version is known', () => {
    const h1 = harness({ bundledVersion: '9.9.9' });
    h1.sup.start();
    expect(h1.sup.tick().versionMismatch).toBe(false);

    const h2 = harness();
    h2.sup.start();
    expect(h2.sup.tick().versionMismatch).toBe(false);
  });
});
