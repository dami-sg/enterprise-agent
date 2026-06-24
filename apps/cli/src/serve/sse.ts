/**
 * SSE event stream for `ea serve` (cli §8, A.2 `onEvent`). One `GET /events`
 * connection per client; each registers a `host.onEvent` listener and receives
 * the raw `AgentStreamEvent` stream as JSON frames. The host fans every event to
 * every connection — addressing (runId/sessionId) is on the event, so a client
 * filters its own.
 *
 * No replay: events are numbered (`id:`) for client correlation, but a dropped
 * connection does NOT get a `Last-Event-ID` backfill (no server-side ring
 * buffer — cli §8 TODO). A reconnecting client re-reads authoritative state via
 * `GET /sessions/:id/tree` and resumes the live stream. For a local sidecar
 * (rock-solid loopback connection) this gap is effectively never hit.
 */
import type { ServerResponse } from 'node:http';
import type { AgentHost, AgentStreamEvent } from '@enterprise-agent/agent-contract';

/** Heartbeat cadence — keeps proxies/clients from idling the connection out. */
const HEARTBEAT_MS = 15_000;

/**
 * Attach an SSE response to the host event stream. Returns a teardown that
 * unsubscribes and clears the heartbeat; the server invokes it when the request
 * closes. The caller has already authenticated and written nothing to `res`.
 */
export function attachSse(host: AgentHost, res: ServerResponse): () => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Defeat proxy buffering so deltas reach the client as they happen.
    'x-accel-buffering': 'no',
  });
  // Advise the client's reconnect backoff (it will reconnect on its own; we have
  // no replay, so this is purely connection hygiene).
  res.write('retry: 2000\n\n');

  let id = 0;
  const unsubscribe = host.onEvent((event: AgentStreamEvent) => {
    id += 1;
    // A single event is one SSE frame: `id:` for client correlation, `data:` the
    // JSON. Events are flat JSON (no embedded newlines) so one data line suffices.
    res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
  });

  const heartbeat = setInterval(() => {
    // Comment frame (`:`) — ignored by EventSource, just keeps the socket warm.
    res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  // Don't let the heartbeat timer keep the process alive on its own.
  heartbeat.unref?.();

  return () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
}
