/**
 * Long-text splitting (gateway §5). Chunks stay within the limit, prefer natural
 * boundaries, and never leave a code fence dangling.
 */
import { describe, it, expect } from 'vitest';
import { splitForLimit } from '../src/render/split.js';

describe('splitForLimit', () => {
  it('returns the text whole when it fits', () => {
    expect(splitForLimit('hello', 100)).toEqual(['hello']);
  });

  it('returns [] for empty text', () => {
    expect(splitForLimit('', 100)).toEqual([]);
  });

  it('every chunk is within the limit', () => {
    const text = 'x'.repeat(10_000);
    const chunks = splitForLimit(text, 4000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('')).toBe(text);
  });

  it('prefers a paragraph boundary', () => {
    const a = 'a'.repeat(60);
    const b = 'b'.repeat(60);
    const chunks = splitForLimit(`${a}\n\n${b}`, 80);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('carries an open code fence across a split', () => {
    const code = 'L'.repeat(120);
    const chunks = splitForLimit('```ts\n' + code, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk opens then closes a fence; the next reopens it.
    expect(chunks[0]!.startsWith('```ts')).toBe(true);
    expect(chunks[0]!.trimEnd().endsWith('```')).toBe(true);
    expect(chunks[1]!.startsWith('```ts')).toBe(true);
  });
});
