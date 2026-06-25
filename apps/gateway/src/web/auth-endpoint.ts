/**
 * Auth endpoints (web-app §3/§6, W1c). Real Telegram login (verify the Login
 * Widget signature, then find-or-create the account) + a dev-only Google login
 * mock (no real OAuth yet) + logout + `me`. The verifiable login logic is pure
 * (`loginWithTelegram` / `loginWithGoogleMock`); the handlers are thin http glue
 * that read the body, call the pure fn, and set the session cookie.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IdentityStore } from '../accounts/identity-store.js';
import type { SessionStore } from '../accounts/session-store.js';
import { authenticate, logout, sessionCookie } from '../accounts/auth-http.js';
import { resolveLogin } from '../accounts/login.js';
import { verifyTelegramLogin, type TelegramLoginData } from '../accounts/telegram-login.js';
import { verifyTelegramOidc } from '../accounts/telegram-oidc.js';
import { readBody, sendJson as json } from './http.js';

export interface AuthDeps {
  identities: IdentityStore;
  sessions: SessionStore;
  /** Bot's Client ID for verifying modern Telegram OIDC `id_token`s (from BotFather). */
  telegramClientId?: string;
  /** Bot token for verifying LEGACY Telegram Login Widget HMAC payloads. */
  telegramBotToken?: string;
  /** Bot username for the legacy Login Widget mount (from env); absent → hide. */
  telegramBotUsername?: string;
  /** Enable the Google login mock (dev only). */
  devAuth?: boolean;
  /** Set `Secure` on the session cookie (default true; off for local http dev). */
  secure?: boolean;
}

export type LoginOutcome =
  | { ok: true; accountId: string; token: string }
  | { ok: false; status: number; error: string };

/** Modern Telegram OIDC: verify the `id_token` (JWKS) and log in (find-or-create + auto-bind). */
export async function loginWithTelegramOidc(deps: AuthDeps, idToken: string): Promise<LoginOutcome> {
  if (!deps.telegramClientId) return { ok: false, status: 503, error: 'telegram login not configured' };
  const v = await verifyTelegramOidc(idToken, { clientId: deps.telegramClientId });
  if (!v.ok || !v.providerUserId) return { ok: false, status: 401, error: v.reason ?? 'invalid id_token' };
  const r = resolveLogin(deps.identities, deps.sessions, {
    provider: 'telegram',
    providerUserId: v.providerUserId,
    displayName: v.displayName,
  });
  return { ok: true, accountId: r.accountId, token: r.token };
}

/** Legacy Telegram Login Widget (HMAC) payload → log in (find-or-create + auto-bind). */
export function loginWithTelegram(deps: AuthDeps, data: TelegramLoginData): LoginOutcome {
  if (!deps.telegramBotToken) return { ok: false, status: 503, error: 'telegram login not configured' };
  const v = verifyTelegramLogin(data, deps.telegramBotToken);
  if (!v.ok || !v.providerUserId) return { ok: false, status: 401, error: v.reason ?? 'invalid telegram login' };
  const r = resolveLogin(deps.identities, deps.sessions, {
    provider: 'telegram',
    providerUserId: v.providerUserId,
    displayName: v.displayName,
  });
  return { ok: true, accountId: r.accountId, token: r.token };
}

/** Dev-only Google mock: log in by email with no real OAuth. */
export function loginWithGoogleMock(deps: AuthDeps, email: string): LoginOutcome {
  if (!deps.devAuth) return { ok: false, status: 404, error: 'not found' };
  const e = email.trim().toLowerCase();
  if (!e) return { ok: false, status: 400, error: 'email required' };
  const r = resolveLogin(deps.identities, deps.sessions, { provider: 'google', providerUserId: e, displayName: e });
  return { ok: true, accountId: r.accountId, token: r.token };
}

// ---- http glue ----

/** Auth payloads are small (a token / an email); cap the body tighter than chat. */
const AUTH_MAX_BODY = 64 * 1024;

function respond(res: ServerResponse, deps: AuthDeps, outcome: LoginOutcome): void {
  if (!outcome.ok) {
    json(res, outcome.status, { error: outcome.error });
    return;
  }
  json(res, 200, { accountId: outcome.accountId }, sessionCookie(outcome.token, { secure: deps.secure ?? true }));
}

/**
 * `POST /api/auth/telegram` — Telegram login callback. Accepts modern OIDC
 * (`{ id_token }`, verified via JWKS) or the legacy Login Widget (`{ ...hash }`,
 * verified via HMAC), whichever the operator's BotFather setup produces.
 */
export async function handleTelegramAuth(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  let body: { id_token?: unknown } & Partial<TelegramLoginData>;
  try {
    body = JSON.parse(await readBody(req, AUTH_MAX_BODY)) as typeof body;
  } catch {
    json(res, 400, { error: 'bad request' });
    return;
  }
  const outcome =
    typeof body.id_token === 'string'
      ? await loginWithTelegramOidc(deps, body.id_token)
      : loginWithTelegram(deps, body as TelegramLoginData);
  respond(res, deps, outcome);
}

/** `POST /api/auth/google/mock` — dev-only email login. */
export async function handleGoogleMockAuth(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): Promise<void> {
  let email = '';
  try {
    email = String((JSON.parse(await readBody(req, AUTH_MAX_BODY)) as { email?: unknown }).email ?? '');
  } catch {
    json(res, 400, { error: 'bad request' });
    return;
  }
  respond(res, deps, loginWithGoogleMock(deps, email));
}

/** `POST /api/auth/logout` — revoke the session + clear the cookie. */
export function handleLogout(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): void {
  const { cookie } = logout(req.headers.cookie, deps.sessions, { secure: deps.secure ?? true });
  json(res, 200, { ok: true }, cookie);
}

/** `GET /api/auth/me` — current session → account info, or 401. */
export function handleMe(req: IncomingMessage, res: ServerResponse, deps: AuthDeps): void {
  const accountId = authenticate(req.headers.cookie, deps.sessions);
  if (!accountId) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const acct = deps.identities.getAccount(accountId);
  json(res, 200, { accountId, displayName: acct?.displayName });
}

/** `GET /api/auth/config` — public auth config for the login page (which buttons to show). */
export function handleAuthConfig(_req: IncomingMessage, res: ServerResponse, deps: AuthDeps): void {
  json(res, 200, {
    telegramClientId: deps.telegramClientId ?? null,
    telegramBot: deps.telegramBotUsername ?? null,
    googleMock: !!deps.devAuth,
  });
}
