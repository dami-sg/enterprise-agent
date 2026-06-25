/**
 * Telegram Login Widget verification (web-app §3.2 / §6) — the security-critical
 * gate. A forged payload (tampered field / wrong bot token / stale auth_date)
 * must be rejected; a genuine one yields the Telegram id as providerUserId.
 */
import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { verifyTelegramLogin, type TelegramLoginData } from '../src/accounts/telegram-login.js';

const BOT_TOKEN = '123456:TEST-bot-token';

/** Sign a payload exactly as Telegram does, so we can test the verifier end-to-end. */
function sign(fields: Record<string, string | number>, botToken = BOT_TOKEN): TelegramLoginData {
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return { ...fields, hash } as TelegramLoginData;
}

const NOW = 1_700_000_000; // fixed clock (seconds)

it('accepts a genuine payload and returns the Telegram id + name', () => {
  const data = sign({ id: 111, first_name: 'Alice', username: 'alice', auth_date: NOW });
  const r = verifyTelegramLogin(data, BOT_TOKEN, { now: NOW + 10 });
  expect(r.ok).toBe(true);
  expect(r.providerUserId).toBe('111');
  expect(r.displayName).toBe('Alice');
});

it('rejects a tampered field (id changed after signing)', () => {
  const data = sign({ id: 111, first_name: 'Alice', auth_date: NOW });
  data.id = 999; // attacker swaps the user id but keeps the old hash
  expect(verifyTelegramLogin(data, BOT_TOKEN, { now: NOW + 10 })).toMatchObject({ ok: false, reason: 'bad hash' });
});

it('rejects a payload signed with a different bot token', () => {
  const data = sign({ id: 111, auth_date: NOW }, 'wrong:token');
  expect(verifyTelegramLogin(data, BOT_TOKEN, { now: NOW + 10 }).ok).toBe(false);
});

it('rejects a stale auth_date (replay window expired)', () => {
  const data = sign({ id: 111, auth_date: NOW });
  expect(verifyTelegramLogin(data, BOT_TOKEN, { now: NOW + 86_400 + 1, maxAgeSec: 86_400 })).toMatchObject({
    ok: false,
    reason: 'stale auth_date',
  });
});

it('rejects a missing hash', () => {
  expect(verifyTelegramLogin({ id: 111, auth_date: NOW } as TelegramLoginData, BOT_TOKEN, { now: NOW }).ok).toBe(false);
});

it('falls back to username when no name is present', () => {
  const data = sign({ id: 222, username: 'bob', auth_date: NOW });
  const r = verifyTelegramLogin(data, BOT_TOKEN, { now: NOW + 10 });
  expect(r.ok).toBe(true);
  expect(r.displayName).toBe('bob');
});
