/**
 * Account + cross-channel identity store (web-app §3 / cross-channel-memory §3).
 * The shared foundation both the Web spec and the memory spec depend on:
 *
 *   accounts.json       Account   { accountId, displayName?, createdAt }
 *   identities.json     Identity  { provider, providerUserId } → accountId
 *   link-pending.json   LinkToken { token, accountId, expiresAt, used }
 *
 * Identity binding is **many-to-one** (web-app §3.1): one external identity
 * (provider, providerUserId) belongs to exactly one account, but an account may
 * own arbitrarily many identities — including several of the same provider. The
 * `provider` for an IM channel equals the channel name and its `providerUserId`
 * equals the inbound `userId` (Telegram `from.id`), so a Telegram login and a
 * bot DM resolve to the same account (web-app §3.3).
 *
 * `resolveAccount` is the single seam the memory namespace policy consumes
 * (cross-channel-memory §3): unbound → `undefined` → no memory.
 *
 * JSON-on-disk, mirroring the Router/SchedulesStore style. Loaded into memory on
 * construction; mutations flush the whole file. Single-process, single-user-
 * scale; swap for a DB later behind the same methods (web-app §8).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Account {
  accountId: string;
  displayName?: string;
  createdAt: number;
}

export interface Identity {
  provider: string;
  providerUserId: string;
  accountId: string;
}

export interface LinkToken {
  token: string;
  accountId: string;
  expiresAt: number;
  used: boolean;
}

function identityKey(provider: string, providerUserId: string): string {
  return `${provider}:${providerUserId}`;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export class IdentityStore {
  private readonly accountsPath: string;
  private readonly identitiesPath: string;
  private readonly tokensPath: string;

  private accounts: Map<string, Account>;
  private identities: Map<string, Identity>; // key = provider:providerUserId
  private tokens: Map<string, LinkToken>;

  constructor(dir: string) {
    this.accountsPath = join(dir, 'accounts.json');
    this.identitiesPath = join(dir, 'identities.json');
    this.tokensPath = join(dir, 'link-pending.json');
    this.accounts = new Map(readJson<Account[]>(this.accountsPath, []).map((a) => [a.accountId, a]));
    this.identities = new Map(
      readJson<Identity[]>(this.identitiesPath, []).map((i) => [identityKey(i.provider, i.providerUserId), i]),
    );
    this.tokens = new Map(readJson<LinkToken[]>(this.tokensPath, []).map((t) => [t.token, t]));
  }

  // —— accounts ————————————————————————————————————————————————————————————

  createAccount(opts: { displayName?: string; accountId?: string; now?: number } = {}): Account {
    const accountId = opts.accountId ?? `acct_${randomUUID()}`;
    if (this.accounts.has(accountId)) throw new Error(`account already exists: ${accountId}`);
    const account: Account = {
      accountId,
      displayName: opts.displayName,
      createdAt: opts.now ?? Date.now(),
    };
    this.accounts.set(accountId, account);
    this.flushAccounts();
    return account;
  }

  getAccount(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  // —— identities (many-to-one) ——————————————————————————————————————————————

  /**
   * Bind an external identity to an account. Idempotent if already bound to the
   * SAME account; throws if it belongs to a DIFFERENT account (caller must
   * unbind first — web-app §3.1). The account must exist.
   */
  bind(provider: string, providerUserId: string, accountId: string): Identity {
    if (!this.accounts.has(accountId)) throw new Error(`unknown account: ${accountId}`);
    const key = identityKey(provider, providerUserId);
    const existing = this.identities.get(key);
    if (existing) {
      if (existing.accountId === accountId) return existing; // idempotent
      throw new Error(
        `identity ${key} already bound to ${existing.accountId}; unbind before rebinding`,
      );
    }
    const identity: Identity = { provider, providerUserId, accountId };
    this.identities.set(key, identity);
    this.flushIdentities();
    return identity;
  }

  unbind(provider: string, providerUserId: string): boolean {
    const removed = this.identities.delete(identityKey(provider, providerUserId));
    if (removed) this.flushIdentities();
    return removed;
  }

  /** The seam memory consumes (cross-channel-memory §3): unbound → undefined. */
  resolveAccount(provider: string, providerUserId: string): string | undefined {
    return this.identities.get(identityKey(provider, providerUserId))?.accountId;
  }

  listIdentities(accountId: string): Identity[] {
    return [...this.identities.values()].filter((i) => i.accountId === accountId);
  }

  // —— link tokens (Google user binds a Telegram bot DM, web-app §3.3) ————————

  issueLinkToken(accountId: string, opts: { ttlMs?: number; now?: number; token?: string } = {}): LinkToken {
    if (!this.accounts.has(accountId)) throw new Error(`unknown account: ${accountId}`);
    const now = opts.now ?? Date.now();
    const token: LinkToken = {
      token: opts.token ?? randomUUID(),
      accountId,
      expiresAt: now + (opts.ttlMs ?? 10 * 60_000), // default 10 min
      used: false,
    };
    this.tokens.set(token.token, token);
    this.flushTokens();
    return token;
  }

  /**
   * Redeem a link token: returns its accountId and marks it used. A token is
   * single-use and time-bound — unknown / expired / already-used → undefined.
   */
  redeemLinkToken(token: string, opts: { now?: number } = {}): string | undefined {
    const now = opts.now ?? Date.now();
    const t = this.tokens.get(token);
    if (!t || t.used || t.expiresAt < now) return undefined;
    t.used = true;
    this.tokens.set(token, t);
    this.flushTokens();
    return t.accountId;
  }

  // —— persistence ——————————————————————————————————————————————————————————

  private flushAccounts(): void {
    writeJson(this.accountsPath, [...this.accounts.values()]);
  }
  private flushIdentities(): void {
    writeJson(this.identitiesPath, [...this.identities.values()]);
  }
  private flushTokens(): void {
    writeJson(this.tokensPath, [...this.tokens.values()]);
  }
}
