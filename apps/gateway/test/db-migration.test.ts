/**
 * First-run migration of the legacy JSON stores into SQLite (gateway-consolidation
 * §P5): existing accounts.json / identities.json / sessions.json are imported once,
 * idempotently, and become resolvable through the new SQLite-backed stores.
 */
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { IdentityStore } from '../src/accounts/identity-store.js';
import { SessionStore } from '../src/accounts/session-store.js';
import { _resetDbCache } from '../src/accounts/db.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-migrate-'));
});
afterEach(() => {
  _resetDbCache();
  rmSync(dir, { recursive: true, force: true });
});

function seedLegacyJson(): { token: string } {
  writeFileSync(join(dir, 'accounts.json'), JSON.stringify([{ accountId: 'acct_a', displayName: 'Alice', createdAt: 1 }]));
  writeFileSync(
    join(dir, 'identities.json'),
    JSON.stringify([{ provider: 'telegram', providerUserId: '111', accountId: 'acct_a' }]),
  );
  const token = 'legacy-token';
  writeFileSync(
    join(dir, 'sessions.json'),
    JSON.stringify([
      { tokenHash: createHash('sha256').update(token).digest('hex'), accountId: 'acct_a', createdAt: 1, expiresAt: 9_999_999_999_999 },
    ]),
  );
  return { token };
}

it('imports legacy accounts, identities, and access keys on first open', () => {
  const { token } = seedLegacyJson();
  const ids = new IdentityStore(dir);
  expect(ids.getAccount('acct_a')).toMatchObject({ displayName: 'Alice' });
  expect(ids.resolveAccount('telegram', '111')).toBe('acct_a');
  // The imported access key resolves by its raw token (hash matched).
  expect(new SessionStore(dir).resolve(token)).toBe('acct_a');
});

it('skips malformed legacy rows instead of bricking startup, and still marks import done', () => {
  // A hand-edited / truncated legacy file: one good account, one missing accountId,
  // one missing createdAt. The bad rows must be skipped, not thrown on.
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify([
      { accountId: 'acct_ok', displayName: 'OK', createdAt: 5 },
      { displayName: 'no id', createdAt: 6 },
      { accountId: 'acct_no_ts' },
    ]),
  );
  writeFileSync(join(dir, 'identities.json'), JSON.stringify([{ provider: 'telegram', accountId: 'acct_ok' }])); // no providerUserId
  writeFileSync(join(dir, 'sessions.json'), '{ this is not valid json');

  // First open must NOT throw despite the malformed input.
  const ids = new IdentityStore(dir);
  expect(ids.getAccount('acct_ok')).toMatchObject({ displayName: 'OK' });
  expect(ids.listAccounts()).toHaveLength(1); // only the well-formed account imported

  // Import is marked done, so a reopen does not retry (no crash loop).
  _resetDbCache();
  expect(() => new IdentityStore(dir).listAccounts()).not.toThrow();
  expect(new IdentityStore(dir).listAccounts()).toHaveLength(1);
});

it('is idempotent — a second open does not duplicate or re-import', () => {
  seedLegacyJson();
  const first = new IdentityStore(dir);
  first.createAccount({ accountId: 'acct_b' }); // a post-migration write
  expect(first.listAccounts()).toHaveLength(2);

  _resetDbCache(); // reopen from disk
  const second = new IdentityStore(dir);
  // Still exactly 2 (no re-import of the JSON on top of the DB state).
  expect(second.listAccounts()).toHaveLength(2);
  expect(second.resolveAccount('telegram', '111')).toBe('acct_a');
});
