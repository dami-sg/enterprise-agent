/**
 * `ea serve` HTTP+SSE transport (cli §8). These tests drive the server against a
 * scripted fake `AgentHost` and assert the wire layer only: routes reach the
 * right host method, auth/Host-header guards reject, and the SSE stream fans
 * `host.onEvent` out as frames. The host's own behavior is out of scope here —
 * the fake just records calls (mirrors headless-run.test.ts's approach).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AgentHost, AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { startServeServer, type ServeHandle } from '../src/serve/server.js';

interface Recorder {
  startSession: unknown[];
  sendMessage: { id: string; text: string }[];
  approvals: { toolCallId: string; decision: string }[];
  aborts: string[];
  emit: (e: AgentStreamEvent) => void;
}

function fakeHost(): { host: AgentHost; rec: Recorder } {
  const listeners = new Set<(e: AgentStreamEvent) => void>();
  const rec: Recorder = {
    startSession: [],
    sendMessage: [],
    approvals: [],
    aborts: [],
    emit: (e) => listeners.forEach((l) => l(e)),
  };
  const host = {
    async listSessions() {
      return [{ id: 's1', name: 'One' }];
    },
    async startSession(input: unknown) {
      rec.startSession.push(input);
      return { sessionId: 's1', runId: 'r1' };
    },
    async sendMessage(id: string, text: string) {
      rec.sendMessage.push({ id, text });
      return { runId: 'r2' };
    },
    approveTool(toolCallId: string, decision: string) {
      rec.approvals.push({ toolCallId, decision });
    },
    abortRun(runId: string) {
      rec.aborts.push(runId);
    },
    async getSessionTree(id: string) {
      return { rootId: id, nodes: {}, labels: {} };
    },
    onEvent(l: (e: AgentStreamEvent) => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async dispose() {},
  };
  return { host: host as unknown as AgentHost, rec };
}

const TOKEN = 'test-token-abc';
let handle: ServeHandle;
let rec: Recorder;

beforeEach(async () => {
  const fake = fakeHost();
  rec = fake.rec;
  handle = await startServeServer({ host: fake.host, port: 0, token: TOKEN, log: () => {} });
});

afterEach(async () => {
  await handle.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('ea serve — auth & guards', () => {
  it('GET /health is unauthenticated and reports liveness', async () => {
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; pid: number };
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe('number');
  });

  it('rejects a missing/wrong token with 401', async () => {
    expect((await fetch(`${handle.url}/sessions`)).status).toBe(401);
    expect((await fetch(`${handle.url}/sessions`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('accepts ?token= ONLY on the SSE route (EventSource), not other routes', async () => {
    // /events allows the query token (EventSource can't set headers)…
    const ac = new AbortController();
    const ev = await fetch(`${handle.url}/events?token=${TOKEN}`, { signal: ac.signal });
    expect(ev.status).toBe(200);
    ac.abort(); // it's a long-lived SSE stream — close it
    // …but a regular API route rejects it, so the token never rides a loggable URL.
    expect((await fetch(`${handle.url}/sessions?token=${TOKEN}`)).status).toBe(401);
  });

  it('rejects an unexpected Host header with 403 (DNS-rebinding guard)', async () => {
    const status = await rawGet(handle.port, '/health', { host: 'evil.example.com' });
    expect(status).toBe(403);
  });
});

describe('ea serve — command routing', () => {
  it('GET /sessions returns listSessions()', async () => {
    const res = await fetch(`${handle.url}/sessions`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 's1', name: 'One' }]);
  });

  it('POST /sessions/start drives startSession and returns its ids', async () => {
    const res = await fetch(`${handle.url}/sessions/start`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New', goal: 'do it' }),
    });
    expect(await res.json()).toEqual({ sessionId: 's1', runId: 'r1' });
    expect(rec.startSession).toEqual([{ name: 'New', goal: 'do it' }]);
  });

  it('POST /sessions/:id/message passes text through to sendMessage', async () => {
    const res = await fetch(`${handle.url}/sessions/s1/message`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(await res.json()).toEqual({ runId: 'r2' });
    expect(rec.sendMessage).toEqual([{ id: 's1', text: 'hello' }]);
  });

  it('POST /tool-approvals/:id records the decision', async () => {
    await fetch(`${handle.url}/tool-approvals/call-1`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    expect(rec.approvals).toEqual([{ toolCallId: 'call-1', decision: 'once' }]);
  });

  it('POST /runs/:id/abort reaches abortRun', async () => {
    await fetch(`${handle.url}/runs/r9/abort`, { method: 'POST', headers: auth });
    expect(rec.aborts).toEqual(['r9']);
  });

  it('unknown route is 404', async () => {
    expect((await fetch(`${handle.url}/nope`, { headers: auth })).status).toBe(404);
  });
});

describe('ea serve — SSE event stream', () => {
  it('fans a host event out to a connected /events client', async () => {
    const res = await fetch(`${handle.url}/events`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First read drains the initial `retry:` frame; emit once the listener is on.
    const evt: AgentStreamEvent = { kind: 'text-delta', runId: 'r1', agentId: 'a1', text: 'hi' };
    // Give the server a tick to register the onEvent listener, then emit.
    await new Promise((r) => setTimeout(r, 20));
    rec.emit(evt);

    let buf = '';
    while (!buf.includes('"text-delta"')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    expect(buf).toContain('id: 1');
    expect(buf).toContain('data: ' + JSON.stringify(evt));
  });
});

/** Raw GET with a custom Host header (fetch forbids overriding it). Resolves to status. */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}
