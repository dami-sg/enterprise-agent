/**
 * Small filesystem helpers shared across storage and config (agent §5).
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  readdirSync,
  renameSync,
  openSync,
  writeSync,
  closeSync,
  constants as fsConstants,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * App-data files hold provider keys, MCP secrets, and un-redacted-elsewhere
 * session/audit logs. Create directories and files owner-only (0700/0600) so
 * they aren't world-readable on a multi-user host (the default umask often
 * yields 0755/0644). Modes are still masked by umask, but never wider than this.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as T;
}

export function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  ensureDir(dir);
  // Write-then-rename so an interrupted write (crash / `kill -9`) can never leave
  // a truncated, unparseable config behind — `rename(2)` is atomic on the same
  // filesystem, so a reader sees either the old file or the complete new one.
  // The temp name is process-scoped to avoid colliding with a concurrent writer.
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  renameSync(tmp, path);
}

/**
 * Append one JSON record as a single line (agent §5.3). `JSON.stringify` escapes
 * embedded newlines, so a record is always exactly one physical line. Each store
 * file has a single writer process (the AgentHost), and `appendFileSync` is a
 * blocking synchronous `O_APPEND` write, so records never interleave in-process.
 * Across processes O_APPEND keeps each write atomic only up to `PIPE_BUF`; a torn
 * record would still be skipped by `readJsonl` (below) rather than corrupt the
 * parse. If a multi-writer/multi-process scenario is ever introduced, this needs
 * advisory file locking.
 */
export function appendJsonl(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: FILE_MODE });
}

/**
 * Read and parse a JSONL file line by line, skipping blank or unparseable lines.
 * A line that fails to parse (a torn write from a crash, anywhere in the file) is
 * dropped rather than thrown, so one bad record never makes the whole log
 * unreadable (crash-safety, agent §5.3).
 */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // tolerate a torn line (crash-safety, agent §5.3)
    }
  }
  return out;
}

/**
 * Write a file refusing to follow a symlink AT the final path component. The
 * boundary check (path-guard) canonicalizes symlinks at check time, but there is
 * a TOCTOU window before the write in which an attacker (or a concurrent tool
 * call) can swap the target into a symlink pointing outside the boundary. Opening
 * with `O_NOFOLLOW` makes the write fail (ELOOP) in that case instead of escaping.
 * `O_NOFOLLOW` is POSIX-only; on platforms without it (Windows) fall back to a
 * plain write. This closes the final-component swap; intermediate-dir swaps still
 * rely on the OS sandbox as the hard floor (agent §4.1).
 */
export function writeFileNoFollow(path: string, content: string): void {
  const NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (typeof NOFOLLOW !== 'number' || NOFOLLOW === 0) {
    writeFileSync(path, content, 'utf8');
    return;
  }
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW, 0o600);
  try {
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export function listFiles(path: string, ext?: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((e) => e.isFile() && (!ext || e.name.endsWith(ext)))
    .map((e) => e.name);
}
