/**
 * Access-key store (gateway-consolidation §P3 / §P5): issue → resolve a raw
 * token, hashed-at-rest, expiry, single + bulk revoke, unknown-token rejection,
 * and persistence across a fresh connection. SQLite-backed.
 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionStore } from '../src/accounts/session-store.js';
import { _resetDbCache } from '../src/accounts/db.js';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-sess-'));
  store = new SessionStore(dir);
});
afterEach(() => {
  _resetDbCache();
  rmSync(dir, { recursive: true, force: true });
});

/** Concatenate the DB + its WAL/shm sidecars (a fresh write may sit in the WAL). */
function dbBytes(): string {
  return ['identity.db', 'identity.db-wal', 'identity.db-shm']
    .map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)).toString('latin1') : ''))
    .join('');
}

it('issues a token that resolves back to the account', () => {
  const { token } = store.issue('acct_a', { now: 1000, ttlMs: 60_000 });
  expect(store.resolve(token, { now: 2000 })).toBe('acct_a');
});

it('stores only the token hash, never the raw token', () => {
  const { token } = store.issue('acct_a');
  const bytes = dbBytes();
  expect(bytes).not.toContain(token); // raw token never persisted
  expect(bytes).toContain(createHash('sha256').update(token).digest('hex')); // hash is
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

it('persists across a fresh connection (reopen)', () => {
  const { token } = store.issue('acct_a', { ttlMs: 60_000 });
  _resetDbCache(); // force a genuine reopen, not the cached connection
  expect(new SessionStore(dir).resolve(token)).toBe('acct_a');
});
