/**
 * Synchronous SQLite backend for the account / identity / access-key stores
 * (gateway-consolidation §P5). Uses the runtime's BUILT-IN SQLite — no native
 * dependency to install or package:
 *
 *   - Node  → `node:sqlite` `DatabaseSync` (Node ≥ 22.13, where the builtin is
 *             available without `--experimental-sqlite`)
 *   - Bun   → `bun:sqlite`  `Database`
 *
 * Both are synchronous, so `SessionStore` / `IdentityStore` keep their exact sync
 * signatures and every caller (authenticateRpc, the IM `/bind` gate,
 * resolveNamespace, the panel) is untouched. The module is loaded via
 * `createRequire` (not `import`) so the runtime-specific builtin resolves
 * synchronously and the other runtime's builtin is never referenced.
 *
 * One shared connection per DB path per process (cached). Cross-process
 * visibility (the panel issues a key, the data plane's next `resolve` sees it)
 * comes from WAL mode + reading committed state on each query — the same
 * guarantee the old "re-read the JSON each call" pattern gave, now transactional.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/** Minimal shape shared by node:sqlite `DatabaseSync` and bun:sqlite `Database`. */
export interface Stmt {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number | bigint };
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

interface SqliteCtor {
  new (path: string): Db;
}

function loadCtor(): SqliteCtor {
  // Only the current runtime's branch is evaluated, so the other builtin is
  // never required (avoids "unknown module" under the wrong runtime).
  try {
    return (isBun ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync) as SqliteCtor;
  } catch (err) {
    // On Node 22.5–22.12 `node:sqlite` is present but gated behind
    // `--experimental-sqlite`, so the require throws. Surface an actionable error
    // instead of a bare "unknown module" (see the >=22.13 engines floor).
    throw new Error(
      `内建 SQLite 不可用（Node 需 ≥ 22.13，或使用 Bun）：${(err as Error).message}`,
    );
  }
}

const cache = new Map<string, Db>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  accountId   TEXT PRIMARY KEY,
  displayName TEXT,
  createdAt   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS identities (
  provider       TEXT NOT NULL,
  providerUserId TEXT NOT NULL,
  accountId      TEXT NOT NULL,
  PRIMARY KEY (provider, providerUserId)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities(accountId);
CREATE TABLE IF NOT EXISTS access_keys (
  tokenHash TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_keys_account ON access_keys(accountId);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * Open (or reuse) the identity DB at `dbPath`. First open ensures the schema,
 * sets WAL, and — once, guarded by a `meta` flag — imports any legacy JSON
 * (`accounts.json` / `identities.json` / `sessions.json`) sitting beside it.
 */
export function openDb(dbPath: string): Db {
  const cached = cache.get(dbPath);
  if (cached) return cached;

  mkdirSync(dirname(dbPath), { recursive: true });
  const Ctor = loadCtor();
  const db = new Ctor(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  migrateFromJson(db, dirname(dbPath));
  cache.set(dbPath, db);
  return db;
}

/** Test/reset seam: close + drop cached connections (so a fresh open reloads). */
export function _resetDbCache(): void {
  for (const db of cache.values()) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  cache.clear();
}

function readJsonArray<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as T[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** One-time import of legacy JSON files. Idempotent: a `meta` flag guards it, and
 *  every insert is `OR IGNORE`, so concurrent openers can't double-import. The
 *  JSON is left in place as a backup (the DB is the source of truth afterward).
 *
 *  Fault-isolated: a malformed/truncated legacy row is validated-then-skipped and
 *  every insert is wrapped, and the `json_imported` flag is set no matter what.
 *  A single bad row must never throw out of `openDb` — that would re-run the import
 *  and re-throw on every subsequent boot, permanently wedging the gateway. */
function migrateFromJson(db: Db, dir: string): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'json_imported'").get();
  if (done) return;

  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  try {
    const accounts = readJsonArray<{ accountId?: unknown; displayName?: unknown; createdAt?: unknown }>(join(dir, 'accounts.json'));
    const identities = readJsonArray<{ provider?: unknown; providerUserId?: unknown; accountId?: unknown }>(join(dir, 'identities.json'));
    const sessions = readJsonArray<{ tokenHash?: unknown; accountId?: unknown; createdAt?: unknown; expiresAt?: unknown }>(join(dir, 'sessions.json'));

    const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (accountId, displayName, createdAt) VALUES (?, ?, ?)');
    for (const a of accounts) {
      if (!a || !str(a.accountId) || !numeric(a.createdAt)) continue; // skip malformed row
      try { insAcc.run(a.accountId, str(a.displayName) ? a.displayName : null, a.createdAt); } catch { /* skip */ }
    }
    const insId = db.prepare('INSERT OR IGNORE INTO identities (provider, providerUserId, accountId) VALUES (?, ?, ?)');
    for (const i of identities) {
      if (!i || !str(i.provider) || !str(i.providerUserId) || !str(i.accountId)) continue;
      try { insId.run(i.provider, i.providerUserId, i.accountId); } catch { /* skip */ }
    }
    const insKey = db.prepare('INSERT OR IGNORE INTO access_keys (tokenHash, accountId, createdAt, expiresAt) VALUES (?, ?, ?, ?)');
    for (const s of sessions) {
      if (!s || !str(s.tokenHash) || !str(s.accountId) || !numeric(s.createdAt) || !numeric(s.expiresAt)) continue;
      try { insKey.run(s.tokenHash, s.accountId, s.createdAt, s.expiresAt); } catch { /* skip */ }
    }
  } catch {
    /* a corrupt file / unexpected shape must not brick startup — fall through and
       still mark the import done (the JSON stays on disk for manual recovery). */
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_imported', '1')").run();
}
