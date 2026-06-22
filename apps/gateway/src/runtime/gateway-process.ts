/**
 * Gateway process lifecycle (gateway §7/§10). The Web panel and the resident
 * gateway (`ea-gateway start`) are separate OS processes; this is the small
 * contract that lets the panel see and control the runtime:
 *
 *   - `ea-gateway start` records its PID via `writeGatewayPid` on boot and
 *     `clearGatewayPid` on graceful shutdown.
 *   - `GatewayProcessManager` reads that PID file to report status (running /
 *     stopped / error) and spawns / signals the process for start / stop / restart.
 *
 * Status is derived purely from the PID file + liveness, so it's correct no matter
 * who started the gateway (the panel, the CLI, or systemd):
 *   - file present + PID alive  → running
 *   - file absent               → stopped  (never started, or a clean shutdown)
 *   - file present + PID dead    → error    (it crashed without clearing the file)
 *
 * `spawn` / `kill` / `isAlive` are injectable so the manager is unit-testable
 * without real child processes.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GatewayPaths } from '../config/paths.js';

export type GatewayState = 'running' | 'stopped' | 'error';

export interface GatewayStatus {
  state: GatewayState;
  pid?: number;
  /** Epoch-ms the recorded process started (for an uptime display). */
  startedAt?: number;
  /** Last lines of the gateway log — the crash reason when `state === 'error'`. */
  detail?: string;
  /** Running, but config changed since it started ⇒ a restart will apply it (§7).
   *  Set by the admin (which knows the config surfaces), not the process manager. */
  stale?: boolean;
}

interface PidRecord {
  pid: number;
  startedAt: number;
}

function readPidRecord(file: string): PidRecord | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as PidRecord;
    return typeof r.pid === 'number' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Record the running gateway's PID (called by `ea-gateway start` on boot). */
export function writeGatewayPid(paths: GatewayPaths, pid: number, startedAt: number): void {
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  writeFileSync(paths.pidFile, JSON.stringify({ pid, startedAt }) + '\n');
}

/** Drop the PID record (called on graceful shutdown) — absence ⇒ "stopped". */
export function clearGatewayPid(paths: GatewayPaths): void {
  rmSync(paths.pidFile, { force: true });
}

/** `process.kill(pid, 0)` probes existence without signalling; EPERM ⇒ alive. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcessManagerDeps {
  paths: GatewayPaths;
  /** App data root to pass through to the spawned `start` (`--root`). */
  root?: string;
  /** Node executable; defaults to the one running the panel. */
  exec?: string;
  /** The `ea-gateway` entry (bin.js); defaults to the script running the panel. */
  bin?: string;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number };
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export class GatewayProcessManager {
  private readonly paths: GatewayPaths;
  private readonly root?: string;
  private readonly exec: string;
  private readonly bin: string;
  private readonly spawn: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number };
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;

  constructor(deps: ProcessManagerDeps) {
    this.paths = deps.paths;
    this.root = deps.root;
    this.exec = deps.exec ?? process.execPath;
    this.bin = deps.bin ?? process.argv[1] ?? '';
    this.spawn = deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
    this.kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.now = deps.now ?? (() => Date.now());
  }

  status(): GatewayStatus {
    const rec = readPidRecord(this.paths.pidFile);
    if (!rec) return { state: 'stopped' };
    if (this.isAlive(rec.pid)) return { state: 'running', pid: rec.pid, startedAt: rec.startedAt };
    // A PID record with a dead process means it exited without cleaning up — i.e.
    // it crashed. Surface the tail of the log as the reason.
    return { state: 'error', pid: rec.pid, startedAt: rec.startedAt, detail: this.tailLog() };
  }

  /** Spawn a detached `ea-gateway start`; no-op if one is already running. */
  start(): GatewayStatus {
    const cur = this.status();
    if (cur.state === 'running') return cur;
    if (!this.bin) throw new Error('无法定位 ea-gateway 启动入口');
    mkdirSync(dirname(this.paths.logFile), { recursive: true });
    const out = openSync(this.paths.logFile, 'a');
    const args = [this.bin, 'start', ...(this.root ? ['--root', this.root] : [])];
    const child = this.spawn(this.exec, args, {
      detached: true,
      stdio: ['ignore', out, out],
    });
    if (typeof child.pid !== 'number') throw new Error('网关进程启动失败');
    // Detach so the resident gateway outlives the panel process.
    (child as { unref?: () => void }).unref?.();
    // Record the PID immediately so status reflects "running" before the child's
    // own writeGatewayPid lands (both write the same pid — idempotent).
    writeGatewayPid(this.paths, child.pid, this.now());
    return { state: 'running', pid: child.pid, startedAt: this.now() };
  }

  /** SIGTERM the recorded process and drop the PID record. */
  stop(): GatewayStatus {
    const rec = readPidRecord(this.paths.pidFile);
    if (rec && this.isAlive(rec.pid)) {
      try {
        this.kill(rec.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    clearGatewayPid(this.paths);
    return { state: 'stopped' };
  }

  /** Stop then start; returns the new status. */
  restart(): GatewayStatus {
    this.stop();
    return this.start();
  }

  private tailLog(lines = 8): string | undefined {
    if (!existsSync(this.paths.logFile)) return undefined;
    try {
      const text = readFileSync(this.paths.logFile, 'utf8').trimEnd();
      if (!text) return undefined;
      return text.split('\n').slice(-lines).join('\n');
    } catch {
      return undefined;
    }
  }
}
