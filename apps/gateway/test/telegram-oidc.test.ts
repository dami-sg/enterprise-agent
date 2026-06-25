/**
 * Modern Telegram Login OIDC verification (https://core.telegram.org/bots/telegram-login).
 * Verifies an `id_token` against a locally-generated key/JWKS: a genuine token
 * logs in; wrong audience / wrong issuer / expired / wrong-key tokens are
 * rejected — the security gate before trusting any Telegram identity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey, type KeyLike } from 'jose';
import { verifyTelegramOidc, TELEGRAM_ISSUER } from '../src/accounts/telegram-oidc.js';
import { loginWithTelegramOidc } from '../src/web/auth-endpoint.js';

const CLIENT_ID = 'bot-client-123';

let priv: KeyLike;
let jwks: JWTVerifyGetKey;
let otherPriv: KeyLike;

beforeAll(async () => {
  const a = await generateKeyPair('RS256');
  priv = a.privateKey;
  const jwk = await exportJWK(a.publicKey);
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  jwks = createLocalJWKSet({ keys: [jwk] });
  otherPriv = (await generateKeyPair('RS256')).privateKey; // an unrelated key (forged signer)
});

function token(
  key: KeyLike,
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: string | number } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuedAt()
    .setIssuer(opts.iss ?? TELEGRAM_ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setExpirationTime(opts.exp ?? '1h')
    .sign(key);
}

describe('verifyTelegramOidc', () => {
  it('accepts a genuine id_token and returns the Telegram id + name', async () => {
    const jwt = await token(priv, { id: 111, name: 'Alice' });
    const r = await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks });
    expect(r.ok).toBe(true);
    expect(r.providerUserId).toBe('111');
    expect(r.displayName).toBe('Alice');
  });

  it('falls back to `sub` when `id` is absent', async () => {
    const jwt = await token(priv, { sub: '222' });
    expect((await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks })).providerUserId).toBe('222');
  });

  it('rejects a wrong audience (token for another bot)', async () => {
    const jwt = await token(priv, { id: 1 }, { aud: 'someone-else' });
    expect((await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks })).ok).toBe(false);
  });

  it('rejects a wrong issuer', async () => {
    const jwt = await token(priv, { id: 1 }, { iss: 'https://evil.example.com' });
    expect((await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks })).ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const jwt = await token(priv, { id: 1 });
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2h later
    expect((await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks, now: future })).ok).toBe(false);
  });

  it('rejects a token signed by an unknown key (forged)', async () => {
    const jwt = await token(otherPriv, { id: 1 });
    expect((await verifyTelegramOidc(jwt, { clientId: CLIENT_ID, jwks })).ok).toBe(false);
  });

  it('rejects garbage', async () => {
    expect((await verifyTelegramOidc('not.a.jwt', { clientId: CLIENT_ID, jwks })).ok).toBe(false);
  });
});

describe('loginWithTelegramOidc (endpoint logic)', () => {
  it('503s when no Client ID is configured', async () => {
    const deps = { identities: {} as never, sessions: {} as never };
    expect(await loginWithTelegramOidc(deps, 'any')).toMatchObject({ ok: false, status: 503 });
  });
});
