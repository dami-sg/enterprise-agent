/**
 * Managed landstrip binary (agent §4.1). The sandbox wraps commands with the
 * `landstrip` CLI; rather than require the user to install it, the host fetches
 * a pinned release once and caches it under the app data root (mirroring the
 * models.dev / per-provider model caches). This keeps the sandbox version locked
 * to what the agent was built against, and makes the default (sandbox-on) work
 * out of the box. Failures are silent — the host falls back to no-sandbox.
 *
 * Release assets (https://github.com/landstrip/landstrip/releases) are per
 * platform/arch gzip tarballs containing a single `landstrip` binary.
 */
import { existsSync, mkdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Pinned landstrip version the agent manages (agent §4.1, "version locked"). */
export const LANDSTRIP_VERSION = '0.15.17';

const RELEASE_BASE = `https://github.com/landstrip/landstrip/releases/download/${LANDSTRIP_VERSION}`;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Release asset name for a platform/arch, or undefined if unsupported. */
export function landstripAsset(platform: NodeJS.Platform, arch: string): string | undefined {
  const v = LANDSTRIP_VERSION;
  if (platform === 'darwin' && arch === 'arm64') return `landstrip-${v}-darwin-arm64.tar.gz`;
  if (platform === 'darwin' && arch === 'x64') return `landstrip-${v}-darwin-x64.tar.gz`;
  if (platform === 'linux' && arch === 'x64') return `landstrip-${v}-linux-x64-musl.tar.gz`;
  if (platform === 'win32' && arch === 'x64') return `landstrip-${v}-win32-x64.tar.gz`;
  return undefined;
}

function cstr(buf: Buffer, off: number, len: number): string {
  let end = off;
  const max = off + len;
  while (end < max && buf[end] !== 0) end += 1;
  return buf.toString('utf8', off, end);
}

/**
 * Extract one named file from a gzip tarball. Minimal single-pass tar reader —
 * enough for the release tarballs (one regular file), no external dependency.
 */
export function extractFromTarGz(gz: Buffer, wantBasenames: string[]): Buffer | undefined {
  const buf = gunzipSync(gz);
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = cstr(buf, off, 100);
    if (name === '') break; // end-of-archive zero block
    const size = parseInt(cstr(buf, off + 124, 12).trim() || '0', 8) || 0;
    const typeflag = buf[off + 156];
    const isFile = typeflag === 0 || typeflag === 0x30; // '\0' or '0'
    const dataStart = off + 512;
    if (isFile && wantBasenames.includes(basename(name))) {
      return Buffer.from(buf.subarray(dataStart, dataStart + size));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

export interface ResolveLandstripOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Resolve the path to the managed landstrip binary, downloading + caching the
 * pinned release on first use. Returns undefined when the platform is
 * unsupported or the download/extract fails (caller falls back to no-sandbox).
 */
export async function resolveLandstripBinary(
  cacheDir: string,
  opts: ResolveLandstripOptions = {},
): Promise<string | undefined> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const asset = landstripAsset(platform, arch);
  if (!asset) return undefined;

  const binName = platform === 'win32' ? 'landstrip.exe' : 'landstrip';
  const dir = join(cacheDir, 'landstrip', LANDSTRIP_VERSION);
  const bin = join(dir, binName);
  // Already cached from a previous run → use it without touching the network.
  if (existsSync(bin) && statSync(bin).size > 0) return bin;

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${RELEASE_BASE}/${asset}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const gz = Buffer.from(await res.arrayBuffer());
    const content = extractFromTarGz(gz, [binName, 'landstrip', 'landstrip.exe']);
    if (!content || content.length === 0) return undefined;
    mkdirSync(dir, { recursive: true });
    writeFileSync(bin, content);
    chmodSync(bin, 0o755);
    return bin;
  } catch {
    return undefined; // offline / unsupported / corrupt — silent fallback
  }
}
