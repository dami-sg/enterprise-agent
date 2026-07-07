/**
 * `/rpc` run-mode + auth resolution (gateway-consolidation §P3a). Covers the
 * order cookie → Bearer key → open-mode loopback trust, and the `managed`
 * rejection path (no loopback免 key).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { SessionStore } from '../src/accounts/session-store.js';
import { _resetDbCache } from '../src/accounts/db.js';
import { resolveAuthMode } from '../src/accounts/auth-mode.js';
import { authenticateRpc } from '../src/web/app-rpc-server.js';
import { SESSION_COOKIE } from '../src/accounts/auth-http.js';

function tmpSessions(): { sessions: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ea-rpc-auth-'));
  return { sessions: new SessionStore(dir), dir };
}

/** Minimal IncomingMessage stand-in: headers + socket.remoteAddress. */
function req(headers: Record<string, string>, remoteAddress = '127.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe('resolveAuthMode', () => {
  const prev = process.env.EA_GATEWAY_AUTH_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.EA_GATEWAY_AUTH_MODE;
    else process.env.EA_GATEWAY_AUTH_MODE = prev;
  });

  it('defaults to open on loopback binds', () => {
    delete process.env.EA_GATEWAY_AUTH_MODE;
    expect(resolveAuthMode('127.0.0.1')).toBe('open');
    expect(resolveAuthMode('localhost')).toBe('open');
    expect(resolveAuthMode(undefined)).toBe('open');
  });

  it('switches to managed on non-loopback binds', () => {
    delete process.env.EA_GATEWAY_AUTH_MODE;
    expect(resolveAuthMode('0.0.0.0')).toBe('managed');
    expect(resolveAuthMode('192.168.1.10')).toBe('managed');
  });

  it('honors the EA_GATEWAY_AUTH_MODE override', () => {
    process.env.EA_GATEWAY_AUTH_MODE = 'managed';
    expect(resolveAuthMode('127.0.0.1')).toBe('managed');
    process.env.EA_GATEWAY_AUTH_MODE = 'open';
    expect(resolveAuthMode('0.0.0.0')).toBe('open');
  });
});

describe('authenticateRpc', () => {
  let cleanup: string[] = [];
  afterEach(() => {
    _resetDbCache();
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    cleanup = [];
  });

  it('resolves a valid session cookie to its accountId (both modes)', () => {
    const { sessions, dir } = tmpSessions();
    cleanup.push(dir);
    const { token } = sessions.issue('acct_1');
    const r = req({ cookie: `${SESSION_COOKIE}=${token}` });
    expect(authenticateRpc(r, sessions, 'managed')).toEqual({ accountId: 'acct_1' });
    expect(authenticateRpc(r, sessions, 'open')).toEqual({ accountId: 'acct_1' });
  });

  it('resolves a valid Bearer access key to its accountId (managed)', () => {
    const { sessions, dir } = tmpSessions();
    cleanup.push(dir);
    const { token } = sessions.issue('acct_2');
    const r = req({ authorization: `Bearer ${token}` }, '203.0.113.5');
    expect(authenticateRpc(r, sessions, 'managed')).toEqual({ accountId: 'acct_2' });
  });

  it('rejects an invalid/absent key in managed mode — even from loopback', () => {
    const { sessions, dir } = tmpSessions();
    cleanup.push(dir);
    expect(authenticateRpc(req({}, '127.0.0.1'), sessions, 'managed')).toBeUndefined();
    expect(authenticateRpc(req({ authorization: 'Bearer nope' }, '127.0.0.1'), sessions, 'managed')).toBeUndefined();
  });

  it('trusts a loopback peer without a key in open mode', () => {
    const { sessions, dir } = tmpSessions();
    cleanup.push(dir);
    expect(authenticateRpc(req({}, '127.0.0.1'), sessions, 'open')).toEqual({ trusted: true });
    expect(authenticateRpc(req({}, '::1'), sessions, 'open')).toEqual({ trusted: true });
  });

  it('does not trust a non-loopback peer even in open mode', () => {
    const { sessions, dir } = tmpSessions();
    cleanup.push(dir);
    expect(authenticateRpc(req({}, '203.0.113.5'), sessions, 'open')).toBeUndefined();
  });
});
