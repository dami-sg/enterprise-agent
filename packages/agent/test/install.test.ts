import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { landstripAsset, extractFromTarGz, resolveLandstripBinary, LANDSTRIP_VERSION } from '../src/sandbox/install.js';

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Build a minimal single-file tar (one 512B header + padded content). */
function makeTar(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8'); // name @0
  header.write('0000644\0', 100, 'utf8'); // mode
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8'); // size (octal)
  header[156] = 0x30; // typeflag '0' = regular file
  header.write('ustar\0', 257, 'utf8');
  const pad = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  const end = Buffer.alloc(1024); // two zero blocks
  return Buffer.concat([header, content, pad, end]);
}

describe('landstripAsset (agent §4.1)', () => {
  it('maps supported platform/arch to the release asset name', () => {
    expect(landstripAsset('darwin', 'arm64')).toBe(`landstrip-${LANDSTRIP_VERSION}-darwin-arm64.tar.gz`);
    expect(landstripAsset('darwin', 'x64')).toBe(`landstrip-${LANDSTRIP_VERSION}-darwin-x64.tar.gz`);
    expect(landstripAsset('linux', 'x64')).toBe(`landstrip-${LANDSTRIP_VERSION}-linux-x64-musl.tar.gz`);
    expect(landstripAsset('win32', 'x64')).toBe(`landstrip-${LANDSTRIP_VERSION}-win32-x64.tar.gz`);
  });
  it('returns undefined for unsupported combos', () => {
    expect(landstripAsset('linux', 'arm64')).toBeUndefined();
    expect(landstripAsset('freebsd', 'x64')).toBeUndefined();
  });
});

describe('extractFromTarGz', () => {
  it('pulls the named binary out of a gzip tarball', () => {
    const payload = Buffer.from('FAKE-LANDSTRIP-BINARY');
    const gz = gzipSync(makeTar('landstrip', payload));
    expect(extractFromTarGz(gz, ['landstrip'])).toEqual(payload);
  });
  it('returns undefined when the wanted file is absent', () => {
    const gz = gzipSync(makeTar('something-else', Buffer.from('x')));
    expect(extractFromTarGz(gz, ['landstrip'])).toBeUndefined();
  });
});

describe('resolveLandstripBinary (download + cache)', () => {
  const cacheDir = (): string => mkdtempSync(join(tmpdir(), 'zt-ls-'));

  it('downloads, extracts, and caches the pinned binary as executable', async () => {
    const payload = Buffer.from('FAKE-LANDSTRIP');
    const gz = gzipSync(makeTar('landstrip', payload));
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain(`/${LANDSTRIP_VERSION}/landstrip-${LANDSTRIP_VERSION}-darwin-arm64.tar.gz`);
      return { ok: true, status: 200, arrayBuffer: async () => gz } as unknown as Response;
    });
    const dir = cacheDir();
    const asset = `landstrip-${LANDSTRIP_VERSION}-darwin-arm64.tar.gz`;
    const checksums = { [asset]: sha256(gz) };
    const bin = await resolveLandstripBinary(dir, { platform: 'darwin', arch: 'arm64', fetchImpl: fetchImpl as never, checksums });
    expect(bin).toBe(join(dir, 'landstrip', LANDSTRIP_VERSION, 'landstrip'));
    expect(readFileSync(bin!)).toEqual(payload);
    expect(statSync(bin!).mode & 0o111).toBeTruthy(); // executable bit set

    // Second call serves from cache — no second fetch.
    const again = await resolveLandstripBinary(dir, { platform: 'darwin', arch: 'arm64', fetchImpl: fetchImpl as never, checksums });
    expect(again).toBe(bin);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('refuses a download whose checksum does not match the pinned hash (fail closed)', async () => {
    const gz = gzipSync(makeTar('landstrip', Buffer.from('TAMPERED')));
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => gz }) as unknown as Response);
    const dir = cacheDir();
    const asset = `landstrip-${LANDSTRIP_VERSION}-darwin-arm64.tar.gz`;
    const bin = await resolveLandstripBinary(dir, {
      platform: 'darwin',
      arch: 'arm64',
      fetchImpl: fetchImpl as never,
      checksums: { [asset]: 'd'.repeat(64) }, // expected ≠ actual
    });
    expect(bin).toBeUndefined();
  });

  it('returns undefined on an unsupported platform (no fetch)', async () => {
    const fetchImpl = vi.fn();
    expect(await resolveLandstripBinary(cacheDir(), { platform: 'linux', arch: 'arm64', fetchImpl: fetchImpl as never })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns undefined (silent) when the download fails', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }) as Response);
    const bin = await resolveLandstripBinary(cacheDir(), { platform: 'darwin', arch: 'arm64', fetchImpl: fetchImpl as never });
    expect(bin).toBeUndefined();
  });
});
