/**
 * Admin panel login (gateway-consolidation §P3c): secret persistence + the
 * stateless, secret-derived session cookie.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateAdminSecret,
  verifyAdminSecret,
  verifyAdminCookie,
  adminCookieValue,
  adminSetCookie,
  ADMIN_COOKIE,
} from '../src/accounts/admin-auth.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-admin-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateAdminSecret', () => {
  it('generates a 0600 secret on first use and reuses it after', () => {
    const path = join(dir, 'admin-secret');
    const first = loadOrCreateAdminSecret(path);
    expect(first.created).toBe(true);
    expect(first.secret.length).toBeGreaterThan(20);
    // 0600 permissions.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // File holds the raw secret.
    expect(readFileSync(path, 'utf8').trim()).toBe(first.secret);
    // Idempotent: a second load returns the same secret, not a new one.
    const second = loadOrCreateAdminSecret(path);
    expect(second.created).toBe(false);
    expect(second.secret).toBe(first.secret);
  });

  it('tightens a pre-existing secret file that has loose permissions', () => {
    const path = join(dir, 'admin-secret');
    writeFileSync(path, 'preexisting-secret\n');
    chmodSync(path, 0o644); // e.g. restored from backup / created under a loose umask
    const loaded = loadOrCreateAdminSecret(path);
    expect(loaded.created).toBe(false);
    expect(loaded.secret).toBe('preexisting-secret');
    // The file is re-tightened to 0600 so a local user can't read the secret.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('secret + cookie verification', () => {
  it('verifies the exact secret only', () => {
    expect(verifyAdminSecret('s3cret', 's3cret')).toBe(true);
    expect(verifyAdminSecret('nope', 's3cret')).toBe(false);
    expect(verifyAdminSecret('', 's3cret')).toBe(false);
    expect(verifyAdminSecret(undefined, 's3cret')).toBe(false);
  });

  it('derives a deterministic cookie and accepts only it', () => {
    const secret = 's3cret';
    const cookieVal = adminCookieValue(secret);
    expect(adminCookieValue(secret)).toBe(cookieVal); // deterministic (survives restart)
    expect(verifyAdminCookie(`${ADMIN_COOKIE}=${cookieVal}`, secret)).toBe(true);
    expect(verifyAdminCookie(`${ADMIN_COOKIE}=wrong`, secret)).toBe(false);
    expect(verifyAdminCookie(undefined, secret)).toBe(false);
    // A cookie derived from a different secret must not validate.
    expect(verifyAdminCookie(`${ADMIN_COOKIE}=${adminCookieValue('other')}`, secret)).toBe(false);
  });

  it('adminSetCookie carries the derived value and HttpOnly', () => {
    const secret = 's3cret';
    const setCookie = adminSetCookie(secret);
    expect(setCookie).toContain(`${ADMIN_COOKIE}=${adminCookieValue(secret)}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
  });
});
