/**
 * Web chat backend core (web-app §4.1/§4.2): session routing (new vs continued,
 * per-account memory namespace + workspace), the run→SSE streaming pipe, and the
 * runChatTurn orchestration — all driven against the FakeHost, no live server.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { ORCHESTRATOR_AGENT_ID } from '@enterprise-agent/agent-contract';
import { Router } from '../src/runtime/router.js';
import { FakeHost } from './helpers.js';
import { resolveWebTurn } from '../src/web/chat-session.js';
import { streamRun, type SseSink } from '../src/web/run-stream.js';
import { runChatTurn } from '../src/web/chat-endpoint.js';

let dir: string;
let host: FakeHost;
let router: Router;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-webchat-'));
  host = new FakeHost();
  router = new Router(join(dir, 'routes.json'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function arraySink(): SseSink & { chunks: string[]; closed: boolean } {
  const s = {
    chunks: [] as string[],
    closed: false,
    write(c: string) {
      s.chunks.push(c);
    },
    close() {
      s.closed = true;
    },
  };
  return s;
}

const td = (text: string, runId: string): AgentStreamEvent => ({ kind: 'text-delta', runId, agentId: ORCHESTRATOR_AGENT_ID, text });
const finish = (runId: string): AgentStreamEvent => ({ kind: 'run-finish', runId, finishReason: 'stop' });

describe('resolveWebTurn (routing, §4.1/§4.3)', () => {
  it('first turn starts a session tagged with memoryNamespace=accountId and binds the route', async () => {
    const t = await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'hi', now: 1, workspaceBase: dir });
    expect(t.created).toBe(true);
    const input = host.calls.startSession[0]!;
    expect(input.config?.memoryNamespace).toBe('acct_a');
    expect(input.workingDir).toBe(join(dir, 'acct_a')); // per-account workspace
    // The route key is account-scoped (web:<accountId>:<threadId>), not the bare
    // client thread id — so it can't be resolved by another account (§4.1/§6).
    expect(router.lookup('web', 'acct_a:th1')?.sessionId).toBe(t.sessionId);
    expect(router.lookup('web', 'th1')).toBeUndefined();
  });

  it('account-scopes the route: a second account reusing the same threadId gets its OWN session', async () => {
    const a = await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'hi', now: 1 });
    const b = await resolveWebTurn(host.asHost(), router, { accountId: 'acct_b', threadId: 'th1', message: 'hi', now: 1 });
    expect(b.created).toBe(true);
    expect(b.sessionId).not.toBe(a.sessionId); // no cross-account resolve/clobber
    expect(host.calls.startSession).toHaveLength(2);
    expect(router.lookup('web', 'acct_a:th1')?.sessionId).toBe(a.sessionId);
    expect(router.lookup('web', 'acct_b:th1')?.sessionId).toBe(b.sessionId);
  });

  it('a second turn on the same thread continues the session (no new session)', async () => {
    const first = await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'hi', now: 1 });
    const second = await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'again', now: 2 });
    expect(second.created).toBe(false);
    expect(second.sessionId).toBe(first.sessionId);
    expect(host.calls.startSession).toHaveLength(1);
    expect(host.calls.sendMessage).toHaveLength(1);
  });

  it('a different thread gets its own session', async () => {
    await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'hi', now: 1 });
    await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th2', message: 'hi', now: 1 });
    expect(host.calls.startSession).toHaveLength(2);
  });

  it('applies the chosen model alias on a new session, and to an existing one', async () => {
    await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'hi', model: 'fast', now: 1 });
    expect(host.calls.startSession[0]!.config?.model?.orchestratorAlias).toBe('fast');
    // a follow-up turn switching model updates the existing session's config
    await resolveWebTurn(host.asHost(), router, { accountId: 'acct_a', threadId: 'th1', message: 'again', model: 'reasoning', now: 2 });
    expect(host.calls.updateSessionConfig.at(-1)?.config.model?.orchestratorAlias).toBe('reasoning');
  });
});

describe('streamRun (run → SSE pipe, §4.2)', () => {
  it('streams a run’s deltas to the sink and closes on run-finish', async () => {
    const sink = arraySink();
    const { done } = streamRun(host.asHost(), 'orch-1', sink);
    host.emit(td('Hello', 'orch-1'));
    host.emit(td(' world', 'orch-1'));
    host.emit(finish('orch-1'));
    await done;
    const out = sink.chunks.join('');
    expect(out).toContain('"type":"text-delta"');
    expect(out).toContain('Hello');
    expect(out).toContain(' world');
    expect(out.trimEnd().endsWith('[DONE]')).toBe(true);
    expect(sink.closed).toBe(true);
  });

  it('ignores events from other runs', async () => {
    const sink = arraySink();
    const { done } = streamRun(host.asHost(), 'orch-1', sink);
    host.emit(td('not mine', 'orch-2'));
    host.emit(finish('orch-1'));
    await done;
    expect(sink.chunks.join('')).not.toContain('not mine');
  });
});

describe('runChatTurn (orchestration)', () => {
  it('routes the turn then streams it; deltas for the new run reach the sink', async () => {
    const sink = arraySink();
    const { runId, done } = await runChatTurn({ host: host.asHost(), router }, { accountId: 'acct_a', threadId: 'th1', message: 'hi' }, sink);
    host.emit(td('answer', runId));
    host.emit(finish(runId));
    await done;
    expect(sink.chunks.join('')).toContain('answer');
    expect(sink.closed).toBe(true);
    expect(host.calls.startSession[0]!.config?.memoryNamespace).toBe('acct_a');
  });
});
