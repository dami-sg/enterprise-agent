/**
 * File-boundary enforcement (agent §4): every file operation is normalized and
 * checked to stay within the session's root paths (workspace root or chat
 * scratch). Defends against path traversal — the JS layer; the kernel sandbox
 * (§4.1) is the second line.
 */
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

export class PathBoundaryError extends Error {
  constructor(public readonly attempted: string) {
    super(`path '${attempted}' is outside the allowed boundary`);
    this.name = 'PathBoundaryError';
  }
}

/**
 * macOS (APFS/HFS+) and Windows are case-insensitive by default, and APFS also
 * Unicode-normalizes filenames. A byte-exact containment test therefore both
 * rejects legitimate differently-cased in-boundary paths AND can disagree with
 * `realpathSync` (which returns the OS's canonical casing) — breaking the
 * "literal blocks `..`, resolved blocks symlink" invariant. Fold to a comparable
 * form: NFC-normalize always, and case-fold where the platform is case-insensitive.
 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function fold(p: string): string {
  const nfc = normalize(p).normalize('NFC');
  return CASE_INSENSITIVE_FS ? nfc.toLowerCase() : nfc;
}

function within(child: string, root: string): boolean {
  const c = fold(child);
  const r = fold(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * Canonicalize by resolving symlinks on the longest existing prefix, then
 * re-appending the non-existent tail (so writes to new files still resolve).
 * Defends against an in-boundary symlink that points outside (agent §4).
 */
function canonicalize(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return abs; // reached the fs root without an existing prefix
    tail.unshift(basename(dir));
    dir = parent;
  }
  try {
    const real = realpathSync(dir);
    return tail.length ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

/**
 * Resolve a (possibly relative) path against the first root, then assert it is
 * contained within one of the allowed roots — checked AFTER symlink resolution.
 * Returns the canonical absolute path.
 */
export function guardPath(input: string, roots: string[]): string {
  if (roots.length === 0) throw new PathBoundaryError(input);
  const abs = isAbsolute(input) ? normalize(input) : resolve(roots[0]!, input);
  const real = canonicalize(abs);
  for (const root of roots) {
    // Both the literal and the symlink-resolved path must stay in a root: the
    // literal blocks `..` traversal, the resolved path blocks symlink escapes.
    if (within(abs, root) && within(real, canonicalize(root))) return real;
  }
  throw new PathBoundaryError(abs);
}

/** The longest directory prefix used as a grant key for write tools (§3.3). */
export function dirPrefix(absPath: string): string {
  const idx = absPath.lastIndexOf(sep);
  return idx <= 0 ? absPath : absPath.slice(0, idx);
}
