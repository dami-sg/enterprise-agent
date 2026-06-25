/**
 * Account + cross-channel identity store (web-app §3 / cross-channel-memory §3):
 * account creation, many-to-one identity binding (incl. same-provider multi-id),
 * rejection of cross-account rebinding, unbind, resolveAccount, and the
 * single-use/time-bound link-token flow.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../src/accounts/identity-store.js';

let dir: string;
let store: IdentityStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-identity-'));
  store = new IdentityStore(join(dir, 'identity'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('accounts', () => {
  it('creates accounts with a generated id and persists them', () => {
    const a = store.createAccount({ displayName: 'Alice' });
    expect(a.accountId).toMatch(/^acct_/);
    expect(store.getAccount(a.accountId)).toMatchObject({ displayName: 'Alice' });
    // reload from disk → still there
    expect(new IdentityStore(join(dir, 'identity')).getAccount(a.accountId)).toBeDefined();
  });

  it('rejects a duplicate explicit accountId', () => {
    store.createAccount({ accountId: 'acct_x' });
    expect(() => store.createAccount({ accountId: 'acct_x' })).toThrow(/already exists/i);
  });
});

describe('identity binding (many-to-one)', () => {
  it('binds an identity and resolves it back to the account', () => {
    const a = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    expect(store.resolveAccount('telegram', '111')).toBe(a.accountId);
    expect(store.resolveAccount('telegram', '999')).toBeUndefined(); // unbound
  });

  it('lets one account own many identities, including same-provider multi-id', () => {
    const a = store.createAccount();
    store.bind('google', 'sub-1', a.accountId);
    store.bind('telegram', '111', a.accountId);
    store.bind('telegram', '222', a.accountId); // a second Telegram number
    expect(store.resolveAccount('google', 'sub-1')).toBe(a.accountId);
    expect(store.resolveAccount('telegram', '111')).toBe(a.accountId);
    expect(store.resolveAccount('telegram', '222')).toBe(a.accountId);
    expect(store.listIdentities(a.accountId)).toHaveLength(3);
  });

  it('is idempotent when rebinding to the same account', () => {
    const a = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    expect(() => store.bind('telegram', '111', a.accountId)).not.toThrow();
    expect(store.listIdentities(a.accountId)).toHaveLength(1);
  });

  it('rejects binding an identity already owned by a different account', () => {
    const a = store.createAccount();
    const b = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    expect(() => store.bind('telegram', '111', b.accountId)).toThrow(/already bound/i);
    expect(store.resolveAccount('telegram', '111')).toBe(a.accountId); // unchanged
  });

  it('rejects binding to an unknown account', () => {
    expect(() => store.bind('telegram', '111', 'acct_ghost')).toThrow(/unknown account/i);
  });

  it('unbind frees the identity for rebinding', () => {
    const a = store.createAccount();
    const b = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    expect(store.unbind('telegram', '111')).toBe(true);
    expect(store.resolveAccount('telegram', '111')).toBeUndefined();
    store.bind('telegram', '111', b.accountId); // now allowed
    expect(store.resolveAccount('telegram', '111')).toBe(b.accountId);
    expect(store.unbind('telegram', '111')).toBe(true);
    expect(store.unbind('telegram', '111')).toBe(false); // already gone
  });
});

describe('link tokens (single-use, time-bound)', () => {
  it('redeems a valid token once, returning the account', () => {
    const a = store.createAccount();
    const t = store.issueLinkToken(a.accountId, { now: 1000, ttlMs: 60_000, token: 'tok' });
    expect(t.token).toBe('tok');
    expect(store.redeemLinkToken('tok', { now: 2000 })).toBe(a.accountId);
    // single-use: second redeem fails
    expect(store.redeemLinkToken('tok', { now: 2000 })).toBeUndefined();
  });

  it('rejects expired and unknown tokens', () => {
    const a = store.createAccount();
    store.issueLinkToken(a.accountId, { now: 1000, ttlMs: 60_000, token: 'tok' });
    expect(store.redeemLinkToken('tok', { now: 1000 + 60_001 })).toBeUndefined(); // expired
    expect(store.redeemLinkToken('nope', { now: 2000 })).toBeUndefined(); // unknown
  });

  it('issuing a token for an unknown account throws', () => {
    expect(() => store.issueLinkToken('acct_ghost')).toThrow(/unknown account/i);
  });
});
