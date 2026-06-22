/**
 * Minimal ZIP reader (gateway §7). Round-trips stored + deflate entries and
 * rejects unsafe paths — enough to unpack a skill bundle without a dependency.
 */
import { describe, it, expect } from 'vitest';
import { unzip } from '../src/runtime/unzip.js';
import { buildZip } from './helpers.js';

describe('unzip', () => {
  it('reads a stored (uncompressed) entry', () => {
    const zip = buildZip([{ name: 'SKILL.md', data: Buffer.from('hello'), method: 0 }]);
    const entries = unzip(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe('SKILL.md');
    expect(entries[0]!.data.toString()).toBe('hello');
  });

  it('reads a deflated entry', () => {
    const body = 'x'.repeat(500); // compresses well
    const zip = buildZip([{ name: 'a/SKILL.md', data: Buffer.from(body), method: 8 }]);
    const entries = unzip(zip);
    expect(entries[0]!.path).toBe('a/SKILL.md');
    expect(entries[0]!.data.toString()).toBe(body);
  });

  it('reads multiple entries and skips directory entries', () => {
    const zip = buildZip([
      { name: 'pkg/SKILL.md', data: Buffer.from('md') },
      { name: 'pkg/scripts/run.py', data: Buffer.from('print(1)'), method: 8 },
    ]);
    const paths = unzip(zip).map((e) => e.path).sort();
    expect(paths).toEqual(['pkg/SKILL.md', 'pkg/scripts/run.py']);
  });

  it('rejects an unsafe (path-traversal) entry', () => {
    const zip = buildZip([{ name: '../evil.sh', data: Buffer.from('x') }]);
    expect(() => unzip(zip)).toThrow(/不安全/);
  });

  it('throws on a non-zip buffer', () => {
    expect(() => unzip(Buffer.from('not a zip'))).toThrow(/无效的 zip/);
  });
});
