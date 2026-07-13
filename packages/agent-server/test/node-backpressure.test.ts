import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { sendToSocket } from '../src/node.js';

const OPEN = 1;
const CLOSED = 3;

class FakeWs {
  readyState = OPEN;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(payload: string, cb: (err?: Error) => void): void {
    this.sent.push(payload);
    cb();
  }

  asWs(): WebSocket {
    return this as unknown as WebSocket;
  }
}

describe('sendToSocket backpressure', () => {
  it('resolves once the frame is written while the buffer is below the high-water mark', async () => {
    const ws = new FakeWs();
    await sendToSocket(ws.asWs(), 'hello');
    expect(ws.sent).toEqual(['hello']);
  });

  it('rejects when the socket is not open instead of silently dropping', async () => {
    const ws = new FakeWs();
    ws.readyState = CLOSED;
    await expect(sendToSocket(ws.asWs(), 'hello')).rejects.toThrow(/not open/);
    expect(ws.sent).toEqual([]);
  });

  it('does not resolve until an over-buffered socket drains', async () => {
    const ws = new FakeWs();
    ws.bufferedAmount = 2 * 1024 * 1024; // above the 1 MiB high-water mark
    let settled = false;
    const promise = sendToSocket(ws.asWs(), 'frame').then(() => {
      settled = true;
    });

    // Frame is written immediately, but the send() promise stays pending while
    // the outbound buffer is above the high-water mark (real backpressure).
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.sent).toEqual(['frame']);
    expect(settled).toBe(false);

    ws.bufferedAmount = 0; // consumer catches up
    await promise;
    expect(settled).toBe(true);
  });

  it('rejects when the socket closes while draining', async () => {
    const ws = new FakeWs();
    ws.bufferedAmount = 2 * 1024 * 1024;
    const promise = sendToSocket(ws.asWs(), 'frame');
    await new Promise((r) => setTimeout(r, 40));
    ws.readyState = CLOSED;
    await expect(promise).rejects.toThrow(/draining/);
  });
});
