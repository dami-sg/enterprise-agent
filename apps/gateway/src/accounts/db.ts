/**
 * Synchronous SQLite backend for the account / identity / access-key stores
 * (gateway-consolidation §P5). Uses the runtime's BUILT-IN SQLite — no native
 * dependency to install or package:
 *
 *   - Node  → `node:sqlite` `DatabaseSync` (Node ≥ 22.5, experimental)
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
  return (isBun ? require('bun:sqlite').Database : require('node:sqlite').DatabaseSync) as SqliteCtor;
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
 *  JSON is left in place as a backup (the DB is the source of truth afterward). */
function migrateFromJson(db: Db, dir: string): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'json_imported'").get();
  if (done) return;

  const accounts = readJsonArray<{ accountId: string; displayName?: string; createdAt: number }>(join(dir, 'accounts.json'));
  const identities = readJsonArray<{ provider: string; providerUserId: string; accountId: string }>(join(dir, 'identities.json'));
  const sessions = readJsonArray<{ tokenHash: string; accountId: string; createdAt: number; expiresAt: number }>(join(dir, 'sessions.json'));

  const insAcc = db.prepare('INSERT OR IGNORE INTO accounts (accountId, displayName, createdAt) VALUES (?, ?, ?)');
  for (const a of accounts) insAcc.run(a.accountId, a.displayName ?? null, a.createdAt);
  const insId = db.prepare('INSERT OR IGNORE INTO identities (provider, providerUserId, accountId) VALUES (?, ?, ?)');
  for (const i of identities) insId.run(i.provider, i.providerUserId, i.accountId);
  const insKey = db.prepare('INSERT OR IGNORE INTO access_keys (tokenHash, accountId, createdAt, expiresAt) VALUES (?, ?, ?, ?)');
  for (const s of sessions) insKey.run(s.tokenHash, s.accountId, s.createdAt, s.expiresAt);

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('json_imported', '1')").run();
}
