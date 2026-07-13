/**
 * GatewayRuntime (gateway §2.3): adapter construction from config, the
 * `/platform` control surface (pause / resume / list), and graceful handling of
 * a misconfigured channel (it logs and skips rather than crashing the gateway).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyStore } from '@dami-sg/agent';
import { GatewayRuntime } from '../src/runtime/gateway.js';
import { FakeHost } from './helpers.js';

class MemKeyStore implements KeyStore {
  private m = new Map<string, string>();
  get(ref: string): string | undefined {
    return this.m.get(ref);
  }
  set(ref: string, value: string): void {
    this.m.set(ref, value);
  }
  delete(ref: string): void {
    this.m.delete(ref);
  }
}

const realFetch = globalThis.fetch;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-rt-'));
  // Telegram polls via fetch; keep it harmless (empty updates).
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, result: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(channels: Array<Record<string, unknown>>, keychain: KeyStore): GatewayRuntime {
  const host = new FakeHost();
  const logs: string[] = [];
  const rt = new GatewayRuntime({
    host: host.asHost(),
    keychain,
    config: { channels: channels as never },
    root: dir,
    log: (l) => logs.push(l),
  });
  (rt as unknown as { logs: string[] }).logs = logs;
  return rt;
}

describe('channel lifecycle + platform control', () => {
  it('starts a telegram channel and exposes pause/resume via /platform', async () => {
    const kc = new MemKeyStore();
    kc.set('telegram-bot-token', 'TKN');
    const rt = runtimeWith(
      [{ name: 'telegram', enabled: true, token: { keyRef: 'telegram-bot-token' } }],
      kc,
    );
    await rt.start();
    expect(rt.list()).toEqual([{ name: 'telegram', state: 'running' }]);

    rt.pause('telegram');
    expect(rt.list()[0]!.state).toBe('paused');

    await rt.resume('telegram');
    expect(rt.list()[0]!.state).toBe('running');

    await rt.stop();
    expect(rt.list()[0]!.state).toBe('stopped');
  });

  it('defaults the IM ingress gate to managed and logs it at startup (fail closed)', async () => {
    const prev = process.env.EA_GATEWAY_AUTH_MODE;
    delete process.env.EA_GATEWAY_AUTH_MODE;
    try {
      const rt = runtimeWith([], new MemKeyStore());
      await rt.start();
      const logs = (rt as unknown as { logs: string[] }).logs;
      expect(logs.some((l) => l.includes('IM 接入模式：managed'))).toBe(true);
      await rt.stop();
    } finally {
      if (prev === undefined) delete process.env.EA_GATEWAY_AUTH_MODE;
      else process.env.EA_GATEWAY_AUTH_MODE = prev;
    }
  });

  it('EA_GATEWAY_AUTH_MODE=open opts the IM gate out (personal deployment)', async () => {
    const prev = process.env.EA_GATEWAY_AUTH_MODE;
    process.env.EA_GATEWAY_AUTH_MODE = 'open';
    try {
      const rt = runtimeWith([], new MemKeyStore());
      await rt.start();
      const logs = (rt as unknown as { logs: string[] }).logs;
      expect(logs.some((l) => l.includes('IM 接入模式：open'))).toBe(true);
      await rt.stop();
    } finally {
      if (prev === undefined) delete process.env.EA_GATEWAY_AUTH_MODE;
      else process.env.EA_GATEWAY_AUTH_MODE = prev;
    }
  });

  it('skips a channel with a missing token without crashing the gateway', async () => {
    const rt = runtimeWith([{ name: 'telegram', enabled: true, token: { keyRef: 'absent' } }], new MemKeyStore());
    await rt.start();
    // The channel failed to build → not registered as a running record.
    expect(rt.list()).toEqual([]);
    const logs = (rt as unknown as { logs: string[] }).logs;
    expect(logs.some((l) => l.includes('启动失败'))).toBe(true);
    await rt.stop();
  });
});
