/**
 * Account + cross-channel identity store (web-app §3 / cross-channel-memory §3).
 * The shared foundation the gateway and the memory policy depend on:
 *
 *   accounts    Account   { accountId, displayName?, createdAt }
 *   identities  Identity  { provider, providerUserId } → accountId
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
 * Backed by SQLite (shared identity DB) via the sync adapter ([db.ts]); the API
 * stays synchronous so every caller is unchanged. Migrated from the former JSON
 * (`accounts.json` / `identities.json`) on first open. (The OAuth link-token
 * flow was removed with the Web end — gateway-consolidation §P4.)
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDb, type Db } from './db.js';

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

function rowToAccount(r: Record<string, unknown>): Account {
  return {
    accountId: r.accountId as string,
    displayName: r.displayName == null ? undefined : (r.displayName as string),
    createdAt: r.createdAt as number,
  };
}

function rowToIdentity(r: Record<string, unknown>): Identity {
  return {
    provider: r.provider as string,
    providerUserId: r.providerUserId as string,
    accountId: r.accountId as string,
  };
}

export class IdentityStore {
  private readonly db: Db;

  constructor(dir: string) {
    this.db = openDb(join(dir, 'identity.db'));
  }

  // —— accounts ————————————————————————————————————————————————————————————

  createAccount(opts: { displayName?: string; accountId?: string; now?: number } = {}): Account {
    const accountId = opts.accountId ?? `acct_${randomUUID()}`;
    if (this.db.prepare('SELECT 1 FROM accounts WHERE accountId = ?').get(accountId)) {
      throw new Error(`account already exists: ${accountId}`);
    }
    const account: Account = {
      accountId,
      displayName: opts.displayName,
      createdAt: opts.now ?? Date.now(),
    };
    this.db
      .prepare('INSERT INTO accounts (accountId, displayName, createdAt) VALUES (?, ?, ?)')
      .run(account.accountId, account.displayName ?? null, account.createdAt);
    return account;
  }

  getAccount(accountId: string): Account | undefined {
    const r = this.db.prepare('SELECT accountId, displayName, createdAt FROM accounts WHERE accountId = ?').get(accountId);
    return r ? rowToAccount(r) : undefined;
  }

  listAccounts(): Account[] {
    // `accountId` breaks ties so the order is deterministic across runtimes/SQLite
    // versions even when rows share a `createdAt` (all migrated rows can, e.g. =1).
    return this.db
      .prepare('SELECT accountId, displayName, createdAt FROM accounts ORDER BY createdAt, accountId')
      .all()
      .map(rowToAccount);
  }

  // —— identities (many-to-one) ——————————————————————————————————————————————

  /**
   * Bind an external identity to an account. Idempotent if already bound to the
   * SAME account; throws if it belongs to a DIFFERENT account (caller must
   * unbind first — web-app §3.1). The account must exist.
   */
  bind(provider: string, providerUserId: string, accountId: string): Identity {
    if (!this.db.prepare('SELECT 1 FROM accounts WHERE accountId = ?').get(accountId)) {
      throw new Error(`unknown account: ${accountId}`);
    }
    const existing = this.db
      .prepare('SELECT accountId FROM identities WHERE provider = ? AND providerUserId = ?')
      .get(provider, providerUserId);
    if (existing) {
      if (existing.accountId === accountId) return { provider, providerUserId, accountId }; // idempotent
      throw new Error(
        `identity ${provider}:${providerUserId} already bound to ${existing.accountId}; unbind before rebinding`,
      );
    }
    this.db
      .prepare('INSERT INTO identities (provider, providerUserId, accountId) VALUES (?, ?, ?)')
      .run(provider, providerUserId, accountId);
    return { provider, providerUserId, accountId };
  }

  unbind(provider: string, providerUserId: string): boolean {
    const r = this.db.prepare('DELETE FROM identities WHERE provider = ? AND providerUserId = ?').run(provider, providerUserId);
    return Number(r.changes) > 0;
  }

  /**
   * Unbind every channel identity of an account — a full IM de-provision. Paired
   * with revoking the account's access keys, this is "logout everywhere": the user
   * can no longer resolve to the account and (in managed mode) must `/bind` a fresh
   * key to talk again. Returns how many identities were removed.
   */
  unbindAllForAccount(accountId: string): number {
    const r = this.db.prepare('DELETE FROM identities WHERE accountId = ?').run(accountId);
    return Number(r.changes);
  }

  /** The seam memory consumes (cross-channel-memory §3): unbound → undefined. */
  resolveAccount(provider: string, providerUserId: string): string | undefined {
    const r = this.db
      .prepare('SELECT accountId FROM identities WHERE provider = ? AND providerUserId = ?')
      .get(provider, providerUserId);
    return r ? (r.accountId as string) : undefined;
  }

  listIdentities(accountId: string): Identity[] {
    return this.db
      .prepare('SELECT provider, providerUserId, accountId FROM identities WHERE accountId = ?')
      .all(accountId)
      .map(rowToIdentity);
  }
}
