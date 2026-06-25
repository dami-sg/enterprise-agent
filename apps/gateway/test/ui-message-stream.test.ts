/**
 * AI SDK UI message stream encoder (web-app §4.2): maps a run's AgentStreamEvents
 * to the exact SSE wire format useChat consumes — start · text-start · text-delta
 * · text-end · finish · error · data-* · [DONE], scoped to one orchestrator run.
 */
import { describe, it, expect } from 'vitest';
import { ORCHESTRATOR_AGENT_ID, type AgentStreamEvent } from '@enterprise-agent/agent-contract';
import {
  encodeEvents,
  sseLine,
  SSE_DONE,
  UiMessageStreamEncoder,
  UI_MESSAGE_STREAM_HEADERS,
} from '../src/web/ui-message-stream.js';

const ORCH = ORCHESTRATOR_AGENT_ID;
const RUN = 'orch-1';
const td = (text: string, agentId = ORCH, runId = RUN): AgentStreamEvent => ({ kind: 'text-delta', runId, agentId, text });
const finish = (runId = RUN): AgentStreamEvent => ({ kind: 'run-finish', runId, finishReason: 'stop' });

function parts(sse: string): Array<Record<string, unknown>> {
  return sse
    .split('\n\n')
    .map((l) => l.replace(/^data: /, '').trim())
    .filter((l) => l && l !== '[DONE]')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

it('emits start → text-start → text-delta(s) → text-end → finish → [DONE]', () => {
  const sse = encodeEvents([td('Hello'), td(' world'), finish()], { runId: RUN });
  const ps = parts(sse);
  expect(ps.map((p) => p.type)).toEqual(['start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish']);
  expect(sse.endsWith(SSE_DONE)).toBe(true);
  // deltas carry the text under one stable id
  const deltas = ps.filter((p) => p.type === 'text-delta');
  expect(deltas.map((d) => d.delta)).toEqual(['Hello', ' world']);
  expect(new Set(ps.filter((p) => 'id' in p).map((p) => p.id)).size).toBe(1);
});

it('frames each part as a single SSE event', () => {
  expect(sseLine({ type: 'finish' })).toBe('data: {"type":"finish"}\n\n');
});

it('sets the AI SDK custom-backend header', () => {
  expect(UI_MESSAGE_STREAM_HEADERS['x-vercel-ai-ui-message-stream']).toBe('v1');
  expect(UI_MESSAGE_STREAM_HEADERS['content-type']).toContain('text/event-stream');
});

it('ignores other runs and sub-agent text (only this orchestrator run streams)', () => {
  const sse = encodeEvents(
    [td('mine'), td('other run', ORCH, 'orch-2'), td('sub-agent', 'sub-coder-1'), finish()],
    { runId: RUN },
  );
  const deltas = parts(sse).filter((p) => p.type === 'text-delta');
  expect(deltas.map((d) => d.delta)).toEqual(['mine']);
});

it('maps an error event to an error part then finishes', () => {
  const sse = encodeEvents([td('partial'), { kind: 'error', runId: RUN, message: 'boom' }], { runId: RUN });
  const ps = parts(sse);
  expect(ps.map((p) => p.type)).toEqual(['start', 'text-start', 'text-delta', 'text-end', 'error', 'finish']);
  expect(ps.find((p) => p.type === 'error')!.errorText).toBe('boom');
});

it('streams reasoning as native reasoning parts, closing it before text', () => {
  const rd = (text: string): AgentStreamEvent => ({ kind: 'reasoning-delta', runId: RUN, agentId: ORCH, text });
  const sse = encodeEvents([rd('let me think'), rd('…'), td('Answer'), finish()], { runId: RUN });
  const types = parts(sse).map((p) => p.type);
  expect(types).toEqual([
    'start',
    'reasoning-start',
    'reasoning-delta',
    'reasoning-delta',
    'reasoning-end', // closed when text begins
    'text-start',
    'text-delta',
    'text-end',
    'finish',
  ]);
});

it('closes an open reasoning part on finish even without any text', () => {
  const rd = (text: string): AgentStreamEvent => ({ kind: 'reasoning-delta', runId: RUN, agentId: ORCH, text });
  const types = parts(encodeEvents([rd('thinking'), finish()], { runId: RUN })).map((p) => p.type);
  expect(types).toEqual(['start', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'finish']);
});

it('surfaces a memory-captured perceptibility data part', () => {
  const sse = encodeEvents(
    [td('hi'), { kind: 'memory-captured', sessionId: 's1', runId: RUN, count: 2 }, finish()],
    { runId: RUN },
  );
  const mem = parts(sse).find((p) => p.type === 'data-memory');
  expect(mem).toMatchObject({ type: 'data-memory', data: { count: 2 } });
});

it('surfaces a tool-approval-required as a data-approval part and keeps the stream open', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN });
  const out = enc.onEvent({
    kind: 'tool-approval-required',
    runId: RUN,
    agentId: ORCH,
    toolCallId: 'tc1',
    toolName: 'bash',
    grantScope: 'shell:run',
    input: { command: 'rm -rf build' },
  }).join('');
  const ps = parts(out);
  expect(ps.map((p) => p.type)).toEqual(['start', 'data-approval']);
  expect(ps[1]).toMatchObject({ id: 'tc1', data: { toolCallId: 'tc1', toolName: 'bash', grantScope: 'shell:run', detail: 'rm -rf build' } });
  // No finish/[DONE]: the run is suspended awaiting the decision.
  expect(out).not.toContain('"type":"finish"');
  expect(out).not.toContain(SSE_DONE);
});

it('surfaces a user-question-required as a data-question part', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN });
  const questions = [{ question: '哪个环境?', header: '环境', multiSelect: false, options: [{ label: 'staging' }] }];
  const ps = parts(enc.onEvent({ kind: 'user-question-required', runId: RUN, agentId: ORCH, questionId: 'q1', questions }).join(''));
  expect(ps.map((p) => p.type)).toEqual(['start', 'data-question']);
  expect(ps[1]).toMatchObject({ id: 'q1', data: { questionId: 'q1', questions } });
});

it('surfaces a plan-proposed as a data-plan part', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN });
  const ps = parts(enc.onEvent({ kind: 'plan-proposed', runId: RUN, agentId: ORCH, planId: 'p1', plan: '# do it' }).join(''));
  expect(ps.map((p) => p.type)).toEqual(['start', 'data-plan']);
  expect(ps[1]).toMatchObject({ id: 'p1', data: { planId: 'p1', plan: '# do it' } });
});

it('surfaces todo-update as a reconcilable data-todos part, scoped to the session', () => {
  const todos = [{ id: 't1', content: 'do it', status: 'in_progress' as const }];
  const enc = new UiMessageStreamEncoder({ runId: RUN, sessionId: 's1' });
  const ps = parts(enc.onEvent({ kind: 'todo-update', sessionId: 's1', todos }).join(''));
  expect(ps.map((p) => p.type)).toEqual(['start', 'data-todos']);
  expect(ps[1]).toMatchObject({ id: 'todos', data: { todos } }); // stable id → reconciled in place
});

it('drops todo-update for a different session (no cross-session leak)', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN, sessionId: 's1' });
  expect(enc.onEvent({ kind: 'todo-update', sessionId: 's2', todos: [] })).toEqual([]);
  // and when the encoder has no sessionId, it can't attribute todos → drop
  const enc2 = new UiMessageStreamEncoder({ runId: RUN });
  expect(enc2.onEvent({ kind: 'todo-update', sessionId: 's1', todos: [] })).toEqual([]);
});

it('ignores suspension events from other runs', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN });
  expect(
    enc.onEvent({ kind: 'tool-approval-required', runId: 'orch-2', agentId: ORCH, toolCallId: 'x', toolName: 'bash', input: {} }),
  ).toEqual([]);
});

it('a finish with no text still emits start + finish (empty assistant turn)', () => {
  const sse = encodeEvents([finish()], { runId: RUN });
  expect(parts(sse).map((p) => p.type)).toEqual(['start', 'finish']);
});

it('is idempotent after finish — late events produce nothing', () => {
  const enc = new UiMessageStreamEncoder({ runId: RUN });
  enc.onEvent(td('hi'));
  enc.onEvent(finish());
  expect(enc.onEvent(td('late'))).toEqual([]);
  expect(enc.end()).toEqual([]);
});
