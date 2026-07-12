/**
 * readFile reads only the head of a file (never buffers the whole thing) so an
 * oversized file can't OOM the process, while still reporting the true size.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHarness, type Harness } from './helpers/harness.js';
import { buildFileTools } from '../src/tools/file.js';

const MAX_READ_BYTES = 256 * 1024;

// biome-ignore lint/suspicious/noExplicitAny: test invokes the tool execute directly
const call = (tool: any, input: unknown): Promise<any> => tool.execute(input, { toolCallId: 't1' });

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

describe('readFile', () => {
  it('reads a small file in full', async () => {
    harness = makeHarness();
    const root = harness.rootPaths[0]!;
    writeFileSync(join(root, 'small.txt'), 'hello world');
    const { readFile } = buildFileTools(harness.parent);

    const res = await call(readFile, { path: 'small.txt' });
    expect(res.content).toBe('hello world');
    expect(res.truncated).toBe(false);
    expect(res.bytes).toBe(11);
  });

  it('truncates an oversized file to the head and reports the true size', async () => {
    harness = makeHarness();
    const root = harness.rootPaths[0]!;
    const size = MAX_READ_BYTES + 100_000;
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(size, 0x61)); // 'a' repeated
    const { readFile } = buildFileTools(harness.parent);

    const res = await call(readFile, { path: 'big.txt' });
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(size);
    // Only the head was returned, not the whole file.
    expect(Buffer.byteLength(res.content, 'utf8')).toBe(MAX_READ_BYTES);
  });

  it('rejects a directory path', async () => {
    harness = makeHarness();
    const { readFile } = buildFileTools(harness.parent);
    const res = await call(readFile, { path: '.' });
    expect(res.error).toBe('not_a_file');
  });
});
