/**
 * WeChat inbound media is capped: the CDN response is attacker-influenced, so
 * `readCapped` must abort once the body exceeds the byte limit instead of
 * buffering an unbounded amount into memory (gateway §8.2).
 */
import { describe, it, expect } from 'vitest';
import { readCapped } from '../src/channels/weixin.js';

/** Build a Response streaming `chunks` (so `res.body` is exercised, not arrayBuffer). */
function streamed(chunks: Uint8Array[], headers?: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe('readCapped', () => {
  it('returns the full body when under the cap', async () => {
    const res = streamed([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const buf = await readCapped(res, 1024);
    expect([...buf]).toEqual([1, 2, 3, 4, 5]);
  });

  it('aborts once the streamed body exceeds the cap', async () => {
    const chunk = new Uint8Array(600); // two chunks = 1200 bytes
    const res = streamed([chunk, chunk]);
    await expect(readCapped(res, 1000)).rejects.toThrow(/too large/);
  });

  it('enforces the cap on a non-streaming body too', async () => {
    const res = new Response(new Uint8Array(2000));
    // Force the arrayBuffer path by nulling the body accessor.
    Object.defineProperty(res, 'body', { value: null });
    await expect(readCapped(res, 1000)).rejects.toThrow(/too large/);
  });
});
