/**
 * HTTP auth glue: the cookie → access-key plumbing the `/rpc` surface uses to
 * resolve the `ea_session` cookie to an accountId (app-rpc-server.ts). Kept pure
 * (header string in, accountId out) so it's testable without a live server.
 *
 *   every request → authenticate(req.cookie, sessions) → accountId | undefined → 401
 *
 * (The OAuth login callback + the cookie-issuing/logout helpers went away with the
 * Web end — gateway-consolidation §P4; access keys are now issued by the admin
 * panel / CLI as raw tokens, presented as this cookie or a Bearer header.)
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
