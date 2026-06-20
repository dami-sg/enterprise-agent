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
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
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
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/** Append one JSON record as a line. Append is near-atomic (agent §5.3). */
export function appendJsonl(path: string, record: unknown): void {
  ensureDir(dirname(path));
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Read and parse a JSONL file line by line, skipping blanks/corrupt tails. */
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
      // tolerate a torn final line (crash-safety, agent §5.3)
    }
  }
  return out;
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
