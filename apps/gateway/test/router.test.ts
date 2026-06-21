/**
 * Router (gateway §4): persistence + the reset clock (§4.3). `shouldReset` is
 * pure over an injected `now`, so the idle / daily / command policies are tested
 * deterministically without touching wall-clock time.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router, shouldReset, routeKey, type RouteEntry } from '../src/runtime/router.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-router-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('routes.json persistence', () => {
  it('binds, looks up, persists across instances, and unbinds', () => {
    const file = join(dir, 'routes.json');
    const r = new Router(file);
    r.bind('telegram', 'c1', 's1', 1000);
    expect(r.lookup('telegram', 'c1')?.sessionId).toBe('s1');
    expect(existsSync(file)).toBe(true);

    const reopened = new Router(file);
    expect(reopened.lookup('telegram', 'c1')?.sessionId).toBe('s1');

    reopened.unbind('telegram', 'c1');
    expect(new Router(file).lookup('telegram', 'c1')).toBeUndefined();
  });

  it('keys by channel + conversationId', () => {
    expect(routeKey('weixin', 'abc@im.wechat')).toBe('weixin:abc@im.wechat');
  });
});

describe('shouldReset (gateway §4.3)', () => {
  const entry = (lastActiveAt: number): RouteEntry => ({ sessionId: 's', createdAt: lastActiveAt, lastActiveAt });

  it('command mode never auto-resets', () => {
    expect(shouldReset(entry(0), { mode: 'command' }, 9e12)).toBe(false);
  });

  it('idle resets only after idleMinutes of silence', () => {
    const base = 1_000_000;
    const e = entry(base);
    expect(shouldReset(e, { mode: 'idle', idleMinutes: 60 }, base + 59 * 60_000)).toBe(false);
    expect(shouldReset(e, { mode: 'idle', idleMinutes: 60 }, base + 60 * 60_000)).toBe(true);
  });

  it('daily resets once the configured boundary is crossed', () => {
    // last active 03:00 local; boundary 04:00 same day.
    const lastActive = new Date(2026, 5, 1, 3, 0, 0).getTime();
    const before = new Date(2026, 5, 1, 3, 59, 0).getTime();
    const after = new Date(2026, 5, 1, 4, 1, 0).getTime();
    expect(shouldReset(entry(lastActive), { mode: 'daily', at: '04:00' }, before)).toBe(false);
    expect(shouldReset(entry(lastActive), { mode: 'daily', at: '04:00' }, after)).toBe(true);
  });

  it('no reset config → never resets', () => {
    expect(shouldReset(entry(0), undefined, 9e12)).toBe(false);
  });
});
