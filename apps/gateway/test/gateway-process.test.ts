/**
 * Gateway process manager (gateway §7/§10). Status is derived from the PID file +
 * liveness; start/stop spawn/signal the resident gateway. spawn/kill/isAlive are
 * injected so these run without real child processes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGatewayPaths, type GatewayPaths } from '../src/config/paths.js';
import { GatewayProcessManager, writeGatewayPid } from '../src/runtime/gateway-process.js';

let dir: string;
let paths: GatewayPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-proc-'));
  paths = createGatewayPaths(dir);
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('status', () => {
  it('is "stopped" with no PID file', () => {
    const m = new GatewayProcessManager({ paths, isAlive: () => true });
    expect(m.status().state).toBe('stopped');
  });

  it('is "running" when the recorded PID is alive', () => {
    writeGatewayPid(paths, 1234, 1000);
    const m = new GatewayProcessManager({ paths, isAlive: (pid) => pid === 1234 });
    expect(m.status()).toMatchObject({ state: 'running', pid: 1234, startedAt: 1000 });
  });

  it('is "error" when a PID file remains but the process is gone (crash)', () => {
    writeGatewayPid(paths, 1234, 1000);
    const m = new GatewayProcessManager({ paths, isAlive: () => false });
    expect(m.status().state).toBe('error');
  });
});

describe('start / stop / restart', () => {
  it('start spawns a detached `start` and records the PID', () => {
    const calls: Array<{ cmd: string; args: string[]; detached: unknown }> = [];
    let alive = false;
    const m = new GatewayProcessManager({
      paths,
      root: dir,
      bin: '/x/bin.js',
      isAlive: () => alive,
      now: () => 2000,
      spawn: (cmd, args, opts) => {
        calls.push({ cmd, args, detached: opts.detached });
        alive = true;
        return { pid: 4321 };
      },
    });
    const st = m.start();
    expect(st).toMatchObject({ state: 'running', pid: 4321 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['/x/bin.js', 'start', '--root', dir]);
    expect(calls[0]!.detached).toBe(true);
    expect(JSON.parse(readFileSync(paths.pidFile, 'utf8')).pid).toBe(4321);
  });

  it('start is a no-op when one is already running', () => {
    writeGatewayPid(paths, 999, 1);
    let spawned = 0;
    const m = new GatewayProcessManager({
      paths,
      isAlive: () => true,
      spawn: () => {
        spawned++;
        return { pid: 1 };
      },
    });
    expect(m.start().state).toBe('running');
    expect(spawned).toBe(0);
  });

  it('stop signals the PID and clears the file', () => {
    writeGatewayPid(paths, 777, 1);
    const killed: Array<{ pid: number; sig: string }> = [];
    const m = new GatewayProcessManager({ paths, isAlive: () => true, kill: (pid, sig) => killed.push({ pid, sig }) });
    expect(m.stop().state).toBe('stopped');
    expect(killed).toEqual([{ pid: 777, sig: 'SIGTERM' }]);
    expect(existsSync(paths.pidFile)).toBe(false);
  });
});
