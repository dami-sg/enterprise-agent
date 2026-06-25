/**
 * HTTP auth glue (web-app §6): the cookie ↔ session-token plumbing that the Web
 * endpoints use. Kept pure (header string in, header string / accountId out) so
 * it's testable without a live server, and so the OAuth callback handlers (W1b)
 * only have to call `sessionCookie(token)` / `logout(...)`.
 *
 *   login callback  → resolveLogin(...) → sessionCookie(token)  (Set-Cookie)
 *   every request   → authenticate(req.cookie, sessions)        → accountId | undefined → 401
 *   logout          → logout(req.cookie, sessions)              → revoke + clearing cookie
 */
import type { SessionStore } from './session-store.js';

/** Cookie name for the web session token. */
export const SESSION_COOKIE = 'ea_session';

/** Parse a `Cookie` request header into a name→value map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Extract the raw session token from a request's `Cookie` header. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[SESSION_COOKIE];
}

/**
 * Auth middleware (web-app §6): resolve a request's session cookie to an
 * `accountId`, or `undefined` (→ the caller responds 401). Never trusts anything
 * but the signed/stored session.
 */
export function authenticate(
  cookieHeader: string | undefined,
  sessions: SessionStore,
  opts: { now?: number } = {},
): string | undefined {
  const token = readSessionToken(cookieHeader);
  if (!token) return undefined;
  return sessions.resolve(token, opts);
}

function cookieAttrs(secure: boolean): string[] {
  // Lax: the OAuth callback is a top-level navigation, so the cookie is sent.
  const attrs = ['HttpOnly', 'Path=/', 'SameSite=Lax'];
  if (secure) attrs.push('Secure');
  return attrs;
}

/** `Set-Cookie` value that establishes a session (login). `secure` defaults on (public HTTPS). */
export function sessionCookie(token: string, opts: { maxAgeSec?: number; secure?: boolean } = {}): string {
  const maxAge = opts.maxAgeSec ?? 30 * 24 * 60 * 60; // 30 days
  return [`${SESSION_COOKIE}=${token}`, ...cookieAttrs(opts.secure ?? true), `Max-Age=${maxAge}`].join('; ');
}

/** `Set-Cookie` value that clears the session (logout). */
export function clearSessionCookie(opts: { secure?: boolean } = {}): string {
  return [`${SESSION_COOKIE}=`, ...cookieAttrs(opts.secure ?? true), 'Max-Age=0'].join('; ');
}

/**
 * Log out: revoke the token server-side (so it can't be replayed even if the
 * cookie lingers) and return the clearing `Set-Cookie` value.
 */
export function logout(
  cookieHeader: string | undefined,
  sessions: SessionStore,
  opts: { secure?: boolean } = {},
): { cookie: string; revoked: boolean } {
  const token = readSessionToken(cookieHeader);
  const revoked = token ? sessions.revoke(token) : false;
  return { cookie: clearSessionCookie(opts), revoked };
}
