/**
 * Telegram Login Widget verification (web-app §3.2 / §6). Telegram redirects the
 * browser back with a signed payload; the server MUST verify the `hash` before
 * trusting any field — otherwise anyone could forge a login as any Telegram user.
 *
 * Algorithm (per Telegram docs):
 *   data_check_string = join('\n', sorted "key=value" for every field except `hash`)
 *   secret_key        = SHA256(bot_token)
 *   expected_hash     = HMAC_SHA256(data_check_string, secret_key)  // hex
 *   valid ⇔ expected_hash == hash  AND  auth_date is fresh
 *
 * On success the verified Telegram `id` becomes the identity `providerUserId`
 * for provider `telegram` — the SAME value the bot sees as `from.id`, so a
 * Telegram login auto-binds the bot DM identity (web-app §3.3).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramLoginData {
  id: number | string;
  auth_date: number | string;
  hash: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  [key: string]: string | number | undefined;
}

export interface TelegramLoginResult {
  ok: boolean;
  reason?: string;
  /** Telegram user id as a string (== bot `from.id`), when ok. */
  providerUserId?: string;
  displayName?: string;
}

export function verifyTelegramLogin(
  data: TelegramLoginData,
  botToken: string,
  opts: { maxAgeSec?: number; now?: number } = {},
): TelegramLoginResult {
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== 'string') return { ok: false, reason: 'missing hash' };

  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== '')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secret = createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');

  // Constant-time compare; mismatched length (or non-hex) → reject.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad hash' };
  }

  const maxAge = opts.maxAgeSec ?? 300; // 5 min — a login payload is used immediately; a
  // day-long window let a captured payload be replayed all day. Callers can widen it.
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || now - authDate > maxAge) {
    return { ok: false, reason: 'stale auth_date' };
  }

  const displayName = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username;
  return {
    ok: true,
    providerUserId: String(data.id),
    displayName: displayName ? String(displayName) : undefined,
  };
}
