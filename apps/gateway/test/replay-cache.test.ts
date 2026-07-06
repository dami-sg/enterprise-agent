/**
 * Single-use replay guard (web-app §3.2/§6): a verified Telegram credential may
 * be used exactly once within its lifetime; a repeat is rejected, distinct keys
 * are independent, and an entry is evicted once its TTL elapses.
 */
import { describe, it, expect } from 'vitest';
import { ReplayCache } from '../src/accounts/replay-cache.js';

describe('ReplayCache', () => {
  it('accepts a key once, rejects the repeat', () => {
    const c = new ReplayCache();
    expect(c.consume('k', 1000)).toBe(true);
    expect(c.consume('k', 1000)).toBe(false);
  });

  it('treats distinct keys independently', () => {
    const c = new ReplayCache();
    expect(c.consume('a', 1000)).toBe(true);
    expect(c.consume('b', 1000)).toBe(true);
    expect(c.consume('a', 1000)).toBe(false);
  });

  it('allows reuse only after the TTL has elapsed', () => {
    const c = new ReplayCache(1000); // entry expires at now+1000
    expect(c.consume('k', 0)).toBe(true);
    expect(c.consume('k', 500)).toBe(false); // still within the window
    expect(c.consume('k', 1000)).toBe(true); // expiry reached → evicted → fresh again
  });
});
