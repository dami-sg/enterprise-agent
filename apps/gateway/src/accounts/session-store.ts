/**
 * Access-key store (gateway-consolidation §P3 / §P5). Issues opaque bearer tokens
 * bound to an `accountId`; callers present them on `/rpc` (Bearer), as the web
 * `ea_session` cookie, or in IM `/bind <key>`. Only the token's SHA-256 **hash**
 * is stored — the raw token lives solely with the user — so a leaked store can't
 * be replayed.
 *
 * Backed by SQLite (`access_keys` table, shared identity DB) via the sync adapter
 * ([db.ts]); the public API stays synchronous so every caller is unchanged.
 * Migrated from the former JSON `sessions.json` on first open.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { openDb, type Db } from './db.js';
import { sha256 } from './hash.js';

export interface WebSession {
  /** SHA-256 of the raw token (the raw token is never stored). */
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export class SessionStore {
  private readonly db: Db;

  constructor(dir: string) {
    this.db = openDb(join(dir, 'identity.db'));
  }

  /** Issue a key; returns the RAW token (only its hash is stored). */
  issue(
    accountId: string,
    opts: { ttlMs?: number; now?: number; token?: string } = {},
  ): { token: string; session: WebSession } {
    const token = opts.token ?? randomBytes(32).toString('base64url');
    const now = opts.now ?? Date.now();
    const session: WebSession = {
      tokenHash: sha256(token),
      accountId,
      createdAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    };
    this.db
      .prepare('INSERT OR REPLACE INTO access_keys (tokenHash, accountId, createdAt, expiresAt) VALUES (?, ?, ?, ?)')
      .run(session.tokenHash, session.accountId, session.createdAt, session.expiresAt);
    return { token, session };
  }

  /** Resolve a raw token → accountId, or undefined if unknown/expired. */
  resolve(token: string, opts: { now?: number } = {}): string | undefined {
    const now = opts.now ?? Date.now();
    const row = this.db.prepare('SELECT accountId, expiresAt FROM access_keys WHERE tokenHash = ?').get(sha256(token));
    if (!row || (row.expiresAt as number) < now) return undefined;
    return row.accountId as string;
  }

  /** Revoke a single key (by its raw token). */
  revoke(token: string): boolean {
    const r = this.db.prepare('DELETE FROM access_keys WHERE tokenHash = ?').run(sha256(token));
    return Number(r.changes) > 0;
  }

  /** Revoke every key for an account (logout everywhere); returns the count. */
  revokeAllForAccount(accountId: string): number {
    const r = this.db.prepare('DELETE FROM access_keys WHERE accountId = ?').run(accountId);
    return Number(r.changes);
  }
}
