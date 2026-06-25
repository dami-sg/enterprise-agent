/**
 * Provider-agnostic login orchestration (web-app §3). Both Google (verified
 * OIDC `sub`) and Telegram (verified Login Widget `id`) reduce to a verified
 * `ExternalIdentity`; this is the single seam they feed into:
 *
 *   1. Resolve the identity → an existing account (returning user), or
 *   2. create a new account and auto-bind the identity (first login). For
 *      Telegram this auto-binds the bot DM identity (web-app §3.3), so the
 *      user's private-chat memory is immediately account-scoped.
 *   3. Issue a web session token (the cookie value).
 *
 * Verification (HMAC for Telegram, JWT/JWKS for Google) happens BEFORE this —
 * callers must only pass an already-verified identity.
 */
import type { IdentityStore } from './identity-store.js';
import type { SessionStore } from './session-store.js';

export interface ExternalIdentity {
  /** Identity provider == channel name for IM (web-app §3.1): 'google' | 'telegram' | … */
  provider: string;
  /** Stable per-provider user id (Google `sub`, Telegram `id`). */
  providerUserId: string;
  displayName?: string;
}

export interface LoginResult {
  accountId: string;
  /** True when this login created a brand-new account. */
  created: boolean;
  /** Raw session token to set as the httpOnly cookie. */
  token: string;
}

export function resolveLogin(
  identities: IdentityStore,
  sessions: SessionStore,
  ext: ExternalIdentity,
  opts: { now?: number; sessionTtlMs?: number } = {},
): LoginResult {
  let accountId = identities.resolveAccount(ext.provider, ext.providerUserId);
  let created = false;
  if (!accountId) {
    const account = identities.createAccount({ displayName: ext.displayName, now: opts.now });
    accountId = account.accountId;
    identities.bind(ext.provider, ext.providerUserId, accountId); // auto-bind on first login
    created = true;
  }
  const { token } = sessions.issue(accountId, { now: opts.now, ttlMs: opts.sessionTtlMs });
  return { accountId, created, token };
}
