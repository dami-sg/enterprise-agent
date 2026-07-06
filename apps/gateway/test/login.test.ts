/**
 * Provider-agnostic login orchestration (web-app §3) + the W1c auth endpoints'
 * pure login logic (Telegram verify-then-login).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { IdentityStore } from '../src/accounts/identity-store.js';
import { SessionStore } from '../src/accounts/session-store.js';
import { resolveLogin } from '../src/accounts/login.js';
import { loginWithTelegram, type AuthDeps } from '../src/web/auth-endpoint.js';
import type { TelegramLoginData } from '../src/accounts/telegram-login.js';

let dir: string;
let identities: IdentityStore;
let sessions: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-login-'));
  identities = new IdentityStore(join(dir, 'identity'));
  sessions = new SessionStore(join(dir, 'identity'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('resolveLogin', () => {
  it('first login creates an account, binds the identity, and issues a resolvable session', () => {
    const r = resolveLogin(identities, sessions, { provider: 'google', providerUserId: 'sub-1', displayName: 'Alice' });
    expect(r.created).toBe(true);
    expect(identities.resolveAccount('google', 'sub-1')).toBe(r.accountId);
    expect(sessions.resolve(r.token)).toBe(r.accountId);
  });

  it('a returning identity reuses the same account (no duplicate)', () => {
    const first = resolveLogin(identities, sessions, { provider: 'google', providerUserId: 'sub-1' });
    const second = resolveLogin(identities, sessions, { provider: 'google', providerUserId: 'sub-1' });
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    expect(identities.listAccounts()).toHaveLength(1);
  });

  it('a Telegram login auto-binds the bot DM identity (id == from.id)', () => {
    const r = resolveLogin(identities, sessions, { provider: 'telegram', providerUserId: '111', displayName: 'Alice' });
    expect(identities.resolveAccount('telegram', '111')).toBe(r.accountId);
  });
});

const BOT_TOKEN = '123456:TEST-bot-token';
function signTg(fields: Record<string, string | number>): TelegramLoginData {
  const dcs = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHash('sha256').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dcs).digest('hex');
  return { ...fields, hash } as TelegramLoginData;
}

describe('loginWithTelegram (W1c)', () => {
  function deps(extra: Partial<AuthDeps> = {}): AuthDeps {
    return { identities, sessions, telegramBotToken: BOT_TOKEN, ...extra };
  }

  it('verifies a genuine payload, logs in, and auto-binds the Telegram identity', () => {
    const now = Math.floor(Date.now() / 1000);
    const r = loginWithTelegram(deps(), signTg({ id: 111, first_name: 'Alice', auth_date: now }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sessions.resolve(r.token)).toBe(r.accountId);
    expect(identities.resolveAccount('telegram', '111')).toBe(r.accountId);
  });

  it('rejects a forged payload (401)', () => {
    const data = signTg({ id: 111, auth_date: Math.floor(Date.now() / 1000) });
    data.id = 999; // tamper
    expect(loginWithTelegram(deps(), data)).toMatchObject({ ok: false, status: 401 });
  });

  it('503s when no bot token is configured', () => {
    expect(loginWithTelegram(deps({ telegramBotToken: undefined }), signTg({ id: 1, auth_date: 1 }))).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});
