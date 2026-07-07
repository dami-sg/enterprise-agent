/**
 * Admin panel login (gateway-consolidation §4.4). The config panel is now a
 * resident control plane, so it's gated by a shared admin secret:
 *
 *   - The secret is a random token persisted 0600 at `paths.adminSecret`
 *     (decision §7-B). `loadOrCreateAdminSecret` generates it on first use;
 *     whoever creates it prints it once. Control plane and data plane read the
 *     SAME file (decision §7-E) — idempotent load, so they never diverge.
 *   - Login validates the presented secret and sets an httpOnly cookie whose
 *     value is a deterministic function of the secret (`sha256(secret|admin)`).
 *     Validation recomputes and constant-time compares, so it's STATELESS —
 *     the session survives a panel restart and rotates when the secret changes.
 *
 * The panel still binds loopback + gates Host/Origin (server.ts); this secret is
 * defense-in-depth for a now-resident surface — NOT a license to expose it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCookies } from './auth-http.js';

/** Cookie carrying the admin session (distinct from the web `ea_session`). */
export const ADMIN_COOKIE = 'ea_admin';

export interface AdminSecret {
  secret: string;
  /** True when this call generated a fresh secret (caller should print it once). */
  created: boolean;
}

/** Read the admin secret, generating + persisting one (0600) if absent/empty. */
export function loadOrCreateAdminSecret(path: string): AdminSecret {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return { secret: existing, created: false };
  }
  const secret = randomBytes(24).toString('base64url');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, secret + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // enforce 0600 even if the file pre-existed with a looser mode
  } catch {
    /* best effort */
  }
  return { secret, created: true };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Constant-time string compare (equal-length hex/derived values). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** The cookie value that proves knowledge of the secret (deterministic, stateless). */
export function adminCookieValue(secret: string): string {
  return sha256(secret + '|ea-admin');
}

/** True when the presented login secret matches the stored one. */
export function verifyAdminSecret(input: string | undefined, secret: string): boolean {
  return typeof input === 'string' && input.length > 0 && safeEqual(input, secret);
}

/** True when a request's cookie carries a valid admin session for `secret`. */
export function verifyAdminCookie(cookieHeader: string | undefined, secret: string): boolean {
  const cookie = parseCookies(cookieHeader)[ADMIN_COOKIE];
  return typeof cookie === 'string' && safeEqual(cookie, adminCookieValue(secret));
}

function cookieAttrs(secure: boolean): string[] {
  const attrs = ['HttpOnly', 'Path=/', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  return attrs;
}

/** `Set-Cookie` establishing an admin session (loopback panel ⇒ not Secure). */
export function adminSetCookie(secret: string, opts: { secure?: boolean } = {}): string {
  const maxAge = 7 * 24 * 60 * 60; // 7 days
  return [`${ADMIN_COOKIE}=${adminCookieValue(secret)}`, ...cookieAttrs(opts.secure ?? false), `Max-Age=${maxAge}`].join('; ');
}

/** `Set-Cookie` clearing the admin session (logout). */
export function adminClearCookie(opts: { secure?: boolean } = {}): string {
  return [`${ADMIN_COOKIE}=`, ...cookieAttrs(opts.secure ?? false), 'Max-Age=0'].join('; ');
}
