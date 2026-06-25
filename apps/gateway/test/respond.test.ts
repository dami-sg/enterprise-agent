/**
 * Interactive suspensions over the Web channel (web-app §4.2): the account-scoped
 * pending registry, streamRun registration/clear, and the POST /api/respond
 * handler's authorization + validation (the security-critical surface — one
 * account must never resolve another's approval/question/plan).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ORCHESTRATOR_AGENT_ID, type AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { SessionStore } from '../src/accounts/session-store.js';
import { SESSION_COOKIE } from '../src/accounts/auth-http.js';
import { Router } from '../src/runtime/router.js';
import { PendingResponses } from '../src/web/pending.js';
import { streamRun, type SseSink } from '../src/web/run-stream.js';
import { handleRespondRequest } from '../src/web/chat-endpoint.js';
import type { WebChatDeps } from '../src/web/chat-endpoint.js';
import { FakeHost } from './helpers.js';

describe('PendingResponses (account-scoped registry)', () => {
  it('claim succeeds only for the right account + kind, and consumes the entry', () => {
    const p = new PendingResponses();
    p.register('tc1', { accountId: 'a', kind: 'approval', runId: 'r1' });
    expect(p.claim('tc1', 'b', 'approval')).toBe(false); // wrong account
    expect(p.claim('tc1', 'a', 'question')).toBe(false); // wrong kind
    expect(p.claim('tc1', 'a', 'approval')).toBe(true); // ok
    expect(p.claim('tc1', 'a', 'approval')).toBe(false); // already consumed (no replay)
  });

  it('clearRun drops every suspension of a finished run', () => {
    const p = new PendingResponses();
    p.register('tc1', { accountId: 'a', kind: 'approval', runId: 'r1' });
    p.register('q1', { accountId: 'a', kind: 'question', runId: 'r1' });
    p.register('p1', { accountId: 'a', kind: 'plan', runId: 'r2' });
    p.clearRun('r1');
    expect(p.claim('tc1', 'a', 'approval')).toBe(false);
    expect(p.claim('q1', 'a', 'question')).toBe(false);
    expect(p.claim('p1', 'a', 'plan')).toBe(true); // r2 untouched
  });
});

describe('streamRun registers suspensions to the owning account (§4.2)', () => {
  function arraySink(): SseSink {
    return { write() {}, close() {} };
  }

  it('registers approval/question/plan for the streamed run and clears on finish', () => {
    const host = new FakeHost();
    const pending = new PendingResponses();
    streamRun(host.asHost(), 'r1', arraySink(), { pending, accountId: 'acct_a' });

    host.emit({ kind: 'tool-approval-required', runId: 'r1', agentId: ORCHESTRATOR_AGENT_ID, toolCallId: 'tc1', toolName: 'bash', input: {} });
    host.emit({ kind: 'user-question-required', runId: 'r1', agentId: ORCHESTRATOR_AGENT_ID, questionId: 'q1', questions: [] });
    host.emit({ kind: 'plan-proposed', runId: 'r1', agentId: ORCHESTRATOR_AGENT_ID, planId: 'p1', plan: 'x' });

    // Each is registered to acct_a; claim consumes, so verify each once.
    expect(pending.claim('tc1', 'acct_a', 'approval')).toBe(true);
    expect(pending.claim('q1', 'acct_a', 'question')).toBe(true);
    expect(pending.claim('p1', 'acct_a', 'plan')).toBe(true);
  });

  it('ignores suspensions from other runs and clears on run-finish', () => {
    const host = new FakeHost();
    const pending = new PendingResponses();
    streamRun(host.asHost(), 'r1', arraySink(), { pending, accountId: 'acct_a' });
    host.emit({ kind: 'tool-approval-required', runId: 'OTHER', agentId: ORCHESTRATOR_AGENT_ID, toolCallId: 'x', toolName: 'bash', input: {} });
    expect(pending.claim('x', 'acct_a', 'approval')).toBe(false); // other run not registered

    host.emit({ kind: 'tool-approval-required', runId: 'r1', agentId: ORCHESTRATOR_AGENT_ID, toolCallId: 'tc1', toolName: 'bash', input: {} });
    host.emit({ kind: 'run-finish', runId: 'r1', finishReason: 'stop' } as AgentStreamEvent);
    expect(pending.claim('tc1', 'acct_a', 'approval')).toBe(false); // cleared on finish
  });
});

describe('handleRespondRequest (authorization + validation)', () => {
  let dir: string;
  let host: FakeHost;
  let sessions: SessionStore;
  let pending: PendingResponses;
  let deps: WebChatDeps;
  let tokenA: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-respond-'));
    host = new FakeHost();
    sessions = new SessionStore(dir);
    pending = new PendingResponses();
    deps = { host: host.asHost(), router: new Router(join(dir, 'routes.json')), sessions, pending };
    // The handler authenticates with the real Date.now(), so issue against it.
    tokenA = sessions.issue('acct_a', { now: Date.now(), ttlMs: 3_600_000 }).token;
    return () => rmSync(dir, { recursive: true, force: true });
  });

  function fakeReq(token: string | undefined, body: unknown): IncomingMessage {
    const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & { headers: Record<string, string> };
    r.headers = token ? { cookie: `${SESSION_COOKIE}=${token}` } : {};
    return r;
  }
  function fakeRes(): ServerResponse & { status: number; json: () => Record<string, unknown> } {
    const res = {
      status: 0,
      payload: '',
      writeHead(s: number) {
        res.status = s;
        return res;
      },
      end(b?: string) {
        res.payload = b ?? '';
        return res;
      },
      json: () => JSON.parse(res.payload || '{}') as Record<string, unknown>,
    };
    return res as unknown as ServerResponse & { status: number; json: () => Record<string, unknown> };
  }

  it('401s without a valid session', async () => {
    const res = fakeRes();
    await handleRespondRequest(fakeReq(undefined, { kind: 'approval', id: 'tc1', decision: 'once' }), res, deps);
    expect(res.status).toBe(401);
    expect(host.calls.approveTool).toHaveLength(0);
  });

  it('delivers an approval the account owns', async () => {
    pending.register('tc1', { accountId: 'acct_a', kind: 'approval', runId: 'r1' });
    const res = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'approval', id: 'tc1', decision: 'session' }), res, deps);
    expect(res.status).toBe(200);
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'tc1', decision: 'session' }]);
  });

  it('409s when the suspension belongs to a DIFFERENT account (no cross-account resolve)', async () => {
    pending.register('tc1', { accountId: 'acct_b', kind: 'approval', runId: 'r1' });
    const res = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'approval', id: 'tc1', decision: 'once' }), res, deps);
    expect(res.status).toBe(409);
    expect(host.calls.approveTool).toHaveLength(0);
  });

  it('400s on an invalid approval decision', async () => {
    pending.register('tc1', { accountId: 'acct_a', kind: 'approval', runId: 'r1' });
    const res = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'approval', id: 'tc1', decision: 'bogus' }), res, deps);
    expect(res.status).toBe(400);
    expect(host.calls.approveTool).toHaveLength(0);
    expect(pending.claim('tc1', 'acct_a', 'approval')).toBe(true); // not consumed on validation failure
  });

  it('answers a question (aligned answers) and dismiss (null)', async () => {
    pending.register('q1', { accountId: 'acct_a', kind: 'question', runId: 'r1' });
    const res1 = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'question', id: 'q1', answers: [{ selected: ['staging'] }] }), res1, deps);
    expect(res1.status).toBe(200);
    expect(host.calls.answerQuestion).toEqual([{ questionId: 'q1', answers: [{ selected: ['staging'] }] }]);

    pending.register('q2', { accountId: 'acct_a', kind: 'question', runId: 'r1' });
    const res2 = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'question', id: 'q2', answers: null }), res2, deps);
    expect(res2.status).toBe(200);
    expect(host.calls.answerQuestion[1]).toEqual({ questionId: 'q2', answers: null });
  });

  it('resolves a plan (approve → approve / false → reject)', async () => {
    pending.register('p1', { accountId: 'acct_a', kind: 'plan', runId: 'r1' });
    const res = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'plan', id: 'p1', approve: false }), res, deps);
    expect(res.status).toBe(200);
    expect(host.calls.approvePlan).toEqual([{ planId: 'p1', decision: 'reject' }]);
  });

  it('400s on an unknown kind', async () => {
    const res = fakeRes();
    await handleRespondRequest(fakeReq(tokenA, { kind: 'nope', id: 'x' }), res, deps);
    expect(res.status).toBe(400);
  });
});
