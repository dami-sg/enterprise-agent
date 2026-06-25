/**
 * HTTP auth glue (web-app §6): cookie parsing, the authenticate middleware
 * (cookie → accountId / undefined→401), and the login/logout Set-Cookie values
 * + server-side revocation. Pure — no live server or OAuth needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/accounts/session-store.js';
import {
  authenticate,
  clearSessionCookie,
  logout,
  parseCookies,
  readSessionToken,
  SESSION_COOKIE,
  sessionCookie,
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

describe('login / logout cookies', () => {
  it('sessionCookie is HttpOnly + SameSite + Max-Age, Secure by default', () => {
    const c = sessionCookie('tok', { maxAgeSec: 100 });
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=100');
    expect(c).toContain('Secure');
  });
  it('omits Secure when explicitly disabled (local http dev)', () => {
    expect(sessionCookie('tok', { secure: false })).not.toContain('Secure');
  });
  it('clearSessionCookie expires the cookie (Max-Age=0)', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
  });
  it('logout revokes the token server-side and returns a clearing cookie', () => {
    const { token } = sessions.issue('acct_a', { ttlMs: 60_000 });
    const r = logout(`${SESSION_COOKIE}=${token}`, sessions);
    expect(r.revoked).toBe(true);
    expect(r.cookie).toContain('Max-Age=0');
    // token no longer authenticates even if the cookie were replayed
    expect(authenticate(`${SESSION_COOKIE}=${token}`, sessions)).toBeUndefined();
  });
  it('logout on a request with no session is a no-op revoke but still clears', () => {
    const r = logout(undefined, sessions);
    expect(r.revoked).toBe(false);
    expect(r.cookie).toContain('Max-Age=0');
  });
});
