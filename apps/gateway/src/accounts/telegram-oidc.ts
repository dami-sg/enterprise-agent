/**
 * Modern Telegram Login — OpenID Connect (https://core.telegram.org/bots/telegram-login).
 *
 * The frontend's `Telegram.Login` library performs the OIDC flow and hands the
 * client an `id_token` (a JWT). The server verifies it here:
 *   - signature against Telegram's JWKS,
 *   - `iss` === https://oauth.telegram.org,
 *   - `aud` === the bot's Client ID,
 *   - not expired (`exp`).
 * The verified Telegram user id (`id`, == the bot's `from.id`) becomes the
 * `telegram` identity, so an OIDC web login and a bot DM resolve to one account
 * (web-app §3.3). No Client Secret is needed — id_token verification uses only
 * the public JWKS + the Client ID as audience.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';
export const TELEGRAM_JWKS_URL = 'https://oauth.telegram.org/.well-known/jwks.json';

export interface TelegramOidcResult {
  ok: boolean;
  reason?: string;
  /** Telegram user id (== bot from.id), when ok. */
  providerUserId?: string;
  displayName?: string;
}

let defaultJwks: JWTVerifyGetKey | undefined;
function telegramJwks(): JWTVerifyGetKey {
  // Cached remote JWKS (jose handles fetching + key rotation/caching).
  return (defaultJwks ??= createRemoteJWKSet(new URL(TELEGRAM_JWKS_URL)));
}

/**
 * Verify a Telegram OIDC `id_token`. `clientId` is the bot's Client ID (the
 * expected audience). `jwks` is injectable for tests; production uses Telegram's
 * remote JWKS.
 */
export async function verifyTelegramOidc(
  idToken: string,
  opts: { clientId: string; jwks?: JWTVerifyGetKey; now?: Date },
): Promise<TelegramOidcResult> {
  try {
    const { payload } = await jwtVerify(idToken, opts.jwks ?? telegramJwks(), {
      issuer: TELEGRAM_ISSUER,
      audience: opts.clientId,
      ...(opts.now ? { currentDate: opts.now } : {}),
    });
    const id = payload.id ?? payload.sub;
    if (id === undefined || id === null) return { ok: false, reason: 'missing subject' };
    const name = typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined;
    return { ok: true, providerUserId: String(id), displayName: name };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid id_token' };
  }
}
