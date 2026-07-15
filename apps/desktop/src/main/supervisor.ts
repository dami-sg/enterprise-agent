/**
 * SidecarSupervisor (desktop-app §4): wraps the gateway's own
 * `GatewayProcessManager` (the PID-file contract, gateway §7/§10) with the
 * desktop-specific state machine — periodic liveness polling, crash auto-restart
 * with backoff + a crash-loop fuse, the `stale` config banner, and the §4.5
 * bundled-vs-running version check. All timers/deps are injectable for tests.
 *
 *   stopped ──start()──▶ running ──crash──▶ error ──backoff──▶ start()
 *                                             │ (crashCount > limit)
 *                                             ▼
 *                                           fused (manual start/restart re-arms)
 */
import type { GatewaySnapshot } from '../shared/ipc.js';

/** The slice of GatewayProcessManager the supervisor drives (test seam). */
export interface ProcessManagerLike {
  status(): {
    state: 'running' | 'stopped' | 'error';
    pid?: number;
    startedAt?: number;
    rpcUrl?: string;
    version?: string;
    detail?: string;
  };
  start(): unknown;
  stop(): unknown;
}

export interface SupervisorDeps {
  manager: ProcessManagerLike;
  bundledVersion?: string;
  /** Liveness poll interval (default 5000ms, §4.3). */
  pollMs?: number;
  /** Crash → restart delays; the last entry repeats (default 1s/5s/30s). */
  backoffMs?: number[];
  /** Consecutive crashes before fusing auto-restart (default 3). */
  crashLoopLimit?: number;
  /** Uptime after which a crash streak is considered over (default 60s). */
  stableMs?: number;
  /** Give a spawned gateway this long to open /rpc before `restarting` clears anyway. */
  restartTimeoutMs?: number;
  /** How long restart() waits for the old process to exit before SIGKILL (default 8s).
   *  A client-held socket may stall graceful shutdown; the replacement must not
   *  spawn until the port is actually free (§4.3). */
  stopGraceMs?: number;
  onSnapshot?: (snap: GatewaySnapshot) => void;
  now?: () => number;
  /** Liveness probe for a specific PID (default `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** Hard-kill fallback when the grace period expires (default SIGKILL). */
  killHard?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SidecarSupervisor {
  private readonly manager: ProcessManagerLike;
  private readonly pollMs: number;
  private readonly backoffMs: number[];
  private readonly crashLoopLimit: number;
  private readonly stableMs: number;
  private readonly restartTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly killHard: (pid: number) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly onSnapshot?: (snap: GatewaySnapshot) => void;
  private readonly bundledVersion?: string;

  private timer?: ReturnType<typeof setInterval>;
  private stale = false;
  private fused = false;
  private crashCount = 0;
  /** Deliberately stopped — an absent process is expected, don't auto-restart. */
  private manualStopped = false;
  private nextRestartAt?: number;
  /** Set on start/restart until /rpc is observed (or timeout), drives "重启中". */
  private restartingSince?: number;
  private lastJson = '';

  constructor(deps: SupervisorDeps) {
    this.manager = deps.manager;
    this.pollMs = deps.pollMs ?? 5000;
    this.backoffMs = deps.backoffMs ?? [1000, 5000, 30_000];
    this.crashLoopLimit = deps.crashLoopLimit ?? 3;
    this.stableMs = deps.stableMs ?? 60_000;
    this.restartTimeoutMs = deps.restartTimeoutMs ?? 30_000;
    this.stopGraceMs = deps.stopGraceMs ?? 8000;
    this.now = deps.now ?? (() => Date.now());
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.killHard = deps.killHard ?? ((pid) => process.kill(pid, 'SIGKILL'));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
    this.onSnapshot = deps.onSnapshot;
    this.bundledVersion = deps.bundledVersion;
  }

  /** Begin polling. Adopts an already-running gateway as-is (§4.1: whoever started it). */
  begin(): void {
    this.tick();
    this.timer ??= setInterval(() => this.tick(), this.pollMs);
    // Don't let the poll loop keep a quitting app alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): GatewaySnapshot {
    const st = this.manager.status();
    const restarting =
      this.restartingSince !== undefined &&
      this.now() - this.restartingSince < this.restartTimeoutMs &&
      !(st.state === 'running' && st.rpcUrl);
    return {
      state: st.state,
      pid: st.pid,
      startedAt: st.startedAt,
      rpcUrl: st.rpcUrl,
      version: st.version,
      detail: st.detail,
      stale: this.stale,
      restarting,
      autoRestart: this.fused ? 'fused' : 'armed',
      crashCount: this.crashCount,
      bundledVersion: this.bundledVersion,
      versionMismatch:
        st.state === 'running' && !!this.bundledVersion && st.version !== this.bundledVersion,
    };
  }

  start(): GatewaySnapshot {
    this.manualStopped = false;
    this.rearm();
    this.restartingSince = this.now();
    this.manager.start();
    return this.publish();
  }

  stop(): GatewaySnapshot {
    this.manualStopped = true;
    this.nextRestartAt = undefined;
    this.restartingSince = undefined;
    this.manager.stop();
    return this.publish();
  }

  /** Manual restart (stale banner / version banner / crash card). Re-arms the fuse
   *  and clears `stale` — the new process reads the current config (§4.3). Waits
   *  for the old process to actually release its port before spawning: a client
   *  socket can stall graceful shutdown, and spawning early ⇒ EADDRINUSE loop. */
  async restart(): Promise<GatewaySnapshot> {
    const prev = this.manager.status();
    this.manualStopped = false;
    this.rearm();
    this.stale = false;
    this.restartingSince = this.now();
    this.publish();
    this.manager.stop();
    if (prev.state === 'running' && prev.pid !== undefined) {
      if (!(await this.waitForExit(prev.pid, this.stopGraceMs))) {
        this.log(`[supervisor] 旧进程 ${prev.pid} 未在 ${this.stopGraceMs}ms 内退出，SIGKILL`);
        try {
          this.killHard(prev.pid);
        } catch {
          /* already gone */
        }
        await this.waitForExit(prev.pid, 2000);
      }
    }
    this.manager.start();
    return this.publish();
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.isAlive(pid)) {
      if (this.now() >= deadline) return false;
      await this.sleep(100);
    }
    return true;
  }

  /** Config was written; a restart will apply it (set by the config surface, §4.3). */
  markStale(): GatewaySnapshot {
    this.stale = true;
    return this.publish();
  }

  /** One poll cycle — exposed for tests (production runs it on `pollMs`). */
  tick(): GatewaySnapshot {
    const st = this.manager.status();

    if (st.state === 'running') {
      this.nextRestartAt = undefined;
      // A crash streak ends once the process has stayed up for a while.
      if (this.crashCount > 0 && st.startedAt !== undefined && this.now() - st.startedAt >= this.stableMs) {
        this.crashCount = 0;
      }
      if (this.restartingSince !== undefined && (st.rpcUrl || this.now() - this.restartingSince >= this.restartTimeoutMs)) {
        this.restartingSince = undefined;
      }
    } else if (st.state === 'error' && !this.manualStopped && !this.fused) {
      // Crash (§4.3): schedule an auto-restart with backoff; fuse on a loop.
      if (this.nextRestartAt === undefined) {
        this.crashCount += 1;
        if (this.crashCount > this.crashLoopLimit) {
          this.fused = true;
          this.log(`[supervisor] 连续崩溃 ${this.crashCount} 次，已停止自动重启`);
        } else {
          const delay = this.backoffMs[Math.min(this.crashCount - 1, this.backoffMs.length - 1)]!;
          this.nextRestartAt = this.now() + delay;
          this.log(`[supervisor] 网关崩溃（第 ${this.crashCount} 次），${delay}ms 后自动重启`);
        }
      } else if (this.now() >= this.nextRestartAt) {
        this.nextRestartAt = undefined;
        this.restartingSince = this.now();
        this.manager.start();
      }
    } else if (st.state === 'stopped') {
      this.nextRestartAt = undefined;
    }

    return this.publish();
  }

  private rearm(): void {
    this.fused = false;
    this.crashCount = 0;
    this.nextRestartAt = undefined;
  }

  private publish(): GatewaySnapshot {
    const snap = this.snapshot();
    // Push only actual changes so IPC stays quiet on idle polls.
    const json = JSON.stringify(snap);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.onSnapshot?.(snap);
    }
    return snap;
  }
}
