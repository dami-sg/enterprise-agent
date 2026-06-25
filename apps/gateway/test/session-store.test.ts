/**
 * Web session-token store (web-app §3.1 / §6): issue → resolve a raw token,
 * hashed-at-rest, expiry, single + bulk revoke, and unknown-token rejection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/accounts/session-store.js';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-sess-'));
  store = new SessionStore(dir);
  return () => rmSync(dir, { recursive: true, force: true });
});

it('issues a token that resolves back to the account', () => {
  const { token } = store.issue('acct_a', { now: 1000, ttlMs: 60_000 });
  expect(store.resolve(token, { now: 2000 })).toBe('acct_a');
});

it('stores only the token hash, never the raw token', () => {
  const { token } = store.issue('acct_a');
  const raw = readFileSync(join(dir, 'sessions.json'), 'utf8');
  expect(raw).not.toContain(token);
  expect(raw).toContain('tokenHash');
});

it('rejects expired and unknown tokens', () => {
  const { token } = store.issue('acct_a', { now: 1000, ttlMs: 60_000 });
  expect(store.resolve(token, { now: 1000 + 60_001 })).toBeUndefined(); // expired
  expect(store.resolve('not-a-real-token', { now: 2000 })).toBeUndefined(); // unknown
});

it('revokes a single session (logout)', () => {
  const { token } = store.issue('acct_a', { now: 1000, ttlMs: 60_000 });
  expect(store.revoke(token)).toBe(true);
  expect(store.resolve(token, { now: 2000 })).toBeUndefined();
  expect(store.revoke(token)).toBe(false); // already gone
});

it('revokes all sessions for an account (logout everywhere)', () => {
  const t1 = store.issue('acct_a').token;
  const t2 = store.issue('acct_a').token;
  const tOther = store.issue('acct_b').token;
  expect(store.revokeAllForAccount('acct_a')).toBe(2);
  expect(store.resolve(t1)).toBeUndefined();
  expect(store.resolve(t2)).toBeUndefined();
  expect(store.resolve(tOther)).toBe('acct_b'); // untouched
});

it('persists across reloads', () => {
  const { token } = store.issue('acct_a', { ttlMs: 60_000 });
  expect(new SessionStore(dir).resolve(token)).toBe('acct_a');
});
