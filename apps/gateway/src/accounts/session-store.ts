/**
 * Web session-token store (web-app §3.1 `oauth-sessions`). After a successful
 * OAuth login the server issues an opaque bearer token, set as an httpOnly
 * cookie; subsequent requests resolve it back to an `accountId` (web-app §6).
 *
 * Only the token's SHA-256 **hash** is persisted — the raw token lives solely in
 * the user's cookie. A leaked store file therefore can't be replayed as a
 * session (defense in depth; the token is a bearer credential).
 *
 * JSON-on-disk, mirroring IdentityStore. Single-process scale; swap for a DB /
 * signed-cookie scheme later behind the same methods.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WebSession {
  /** SHA-256 of the raw token (the raw token is never stored). */
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

export class SessionStore {
  private readonly path: string;
  private sessions: Map<string, WebSession>; // key = tokenHash

  constructor(dir: string) {
    this.path = join(dir, 'sessions.json');
    this.sessions = new Map(readJson<WebSession[]>(this.path, []).map((s) => [s.tokenHash, s]));
  }

  /** Issue a session; returns the RAW token (set it as the cookie). Only its hash is stored. */
  issue(accountId: string, opts: { ttlMs?: number; now?: number; token?: string } = {}): { token: string; session: WebSession } {
    const token = opts.token ?? randomBytes(32).toString('base64url');
    const now = opts.now ?? Date.now();
    const session: WebSession = {
      tokenHash: sha256(token),
      accountId,
      createdAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_TTL_MS),
    };
    this.sessions.set(session.tokenHash, session);
    this.flush();
    return { token, session };
  }

  /** Resolve a raw cookie token → accountId, or undefined if unknown/expired. */
  resolve(token: string, opts: { now?: number } = {}): string | undefined {
    const now = opts.now ?? Date.now();
    const s = this.sessions.get(sha256(token));
    if (!s || s.expiresAt < now) return undefined;
    return s.accountId;
  }

  /** Log out a single session (by its raw token). */
  revoke(token: string): boolean {
    const removed = this.sessions.delete(sha256(token));
    if (removed) this.flush();
    return removed;
  }

  /** Log out everywhere for an account (e.g. on unbind / security reset). */
  revokeAllForAccount(accountId: string): number {
    let n = 0;
    for (const [k, s] of this.sessions) {
      if (s.accountId === accountId) {
        this.sessions.delete(k);
        n++;
      }
    }
    if (n) this.flush();
    return n;
  }

  private flush(): void {
    writeJson(this.path, [...this.sessions.values()]);
  }
}
