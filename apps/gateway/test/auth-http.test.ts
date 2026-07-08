/**
 * HTTP auth glue: cookie parsing + the authenticate middleware that resolves the
 * `ea_session` cookie to an accountId (or undefined → 401) for `/rpc`. Pure — no
 * live server needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/accounts/session-store.js';
import {
  authenticate,
  parseCookies,
  readSessionToken,
  SESSION_COOKIE,
} from '../src/accounts/auth-http.js';

let dir: string;
let sessions: SessionStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-authhttp-'));
  sessions = new SessionStore(dir);
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('cookie parsing', () => {
  it('parses multiple cookies with whitespace', () => {
    expect(parseCookies('a=1; b=2;  c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });
  it('returns empty for missing / malformed headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('novalue')).toEqual({});
  });
  it('reads the session cookie by name', () => {
    expect(readSessionToken(`other=x; ${SESSION_COOKIE}=tok123`)).toBe('tok123');
    expect(readSessionToken('other=x')).toBeUndefined();
  });
});

describe('authenticate middleware', () => {
  it('resolves a valid session cookie to the accountId', () => {
    const { token } = sessions.issue('acct_a', { now: 1000, ttlMs: 60_000 });
    expect(authenticate(`${SESSION_COOKIE}=${token}`, sessions, { now: 2000 })).toBe('acct_a');
  });
  it('returns undefined for missing / garbage / expired sessions', () => {
    expect(authenticate(undefined, sessions)).toBeUndefined();
    expect(authenticate(`${SESSION_COOKIE}=nope`, sessions)).toBeUndefined();
    const { token } = sessions.issue('acct_a', { now: 1000, ttlMs: 10 });
    expect(authenticate(`${SESSION_COOKIE}=${token}`, sessions, { now: 99999 })).toBeUndefined();
  });
});
