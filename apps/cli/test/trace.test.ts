import { describe, it, expect } from 'vitest';
import type { AgentStreamEvent, SessionTree } from '@enterprise-agent/agent-contract';
import {
  reduceTrace,
  reconstructTrace,
  initialTrace,
  flattenTrace,
  fmtTok,
  type TraceState,
  type AgentItem,
  type ToolItem,
} from '../src/core/trace.js';

function run(...events: AgentStreamEvent[]): TraceState {
  return events.reduce(reduceTrace, initialTrace());
}

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

describe('reduceTrace (cli §5.3)', () => {
  it('builds an orchestrator node and accumulates streamed text (§3.2)', () => {
    const s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'Hello ' },
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'world' },
    );
    expect(s.rootAgentId).toBe('orch');
    const root = s.agents.get('orch')!;
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({ kind: 'text', text: 'Hello world', speaker: 'assistant' });
    expect(s.status).toBe('running');
  });

  it('keeps turns separate: a @user-text starts a fresh assistant block (issue §3/§4)', () => {
    let s = run({ kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'turn-1 reply' });
    // user sends a second message → appended as a quoted user block
    s = reduceTrace(s, { kind: '@user-text', text: '继续' });
    // the second turn's reply must NOT concatenate onto turn-1's text
    s = reduceTrace(s, { kind: 'text-delta', runId: 'r2', agentId: 'orch', text: 'turn-2 reply' });
    const root = s.agents.get('orch')!;
    expect(root.children).toHaveLength(3);
    expect(root.children[0]).toMatchObject({ kind: 'text', text: 'turn-1 reply', speaker: 'assistant' });
    expect(root.children[1]).toMatchObject({ kind: 'text', text: '继续', speaker: 'user' });
    expect(root.children[2]).toMatchObject({ kind: 'text', text: 'turn-2 reply', speaker: 'assistant' });
  });

  it('collects reasoning into a dim block kept separate from the answer (§2.2)', () => {
    let s = run(
      { kind: 'reasoning-delta', runId: 'r1', agentId: 'orch', text: 'let me ' },
      { kind: 'reasoning-delta', runId: 'r1', agentId: 'orch', text: 'think' },
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'the answer' },
    );
    const root = s.agents.get('orch')!;
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ kind: 'text', text: 'let me think', speaker: 'reasoning' });
    expect(root.children[1]).toMatchObject({ kind: 'text', text: 'the answer', speaker: 'assistant' });
  });

  it('records context-window + cumulative cost from the usage event (§2.6/§2.7)', () => {
    const s = run({
      kind: 'usage',
      runId: 'r1',
      agentId: 'orch',
      usage: { inputTokens: 1800, outputTokens: 200, totalTokens: 2000 },
      totalUsage: { inputTokens: 1800, outputTokens: 200, totalTokens: 2000 },
      cost: 0.05,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    });
    expect(s.contextWindow).toBe(200_000);
    expect(s.maxOutputTokens).toBe(64_000);
    expect(s.lastInputTokens).toBe(1800); // window occupancy for the TopBar gauge
    expect(s.usage.cost).toBeCloseTo(0.05);
  });

  it('matches tool-result to its tool-call and folds the status (§3.1)', () => {
    const s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 't1', toolName: 'readFile', input: { path: 'a.ts' } },
      { kind: 'tool-result', runId: 'r1', agentId: 'orch', toolCallId: 't1', output: '142 lines' },
    );
    const tool = s.tools.get('t1')! as ToolItem;
    expect(tool.status).toBe('ok');
    expect(tool.output).toBe('142 lines');
  });

  it('flags an error result with danger status', () => {
    const s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 't1', toolName: 'runCommand', input: {} },
      { kind: 'tool-result', runId: 'r1', agentId: 'orch', toolCallId: 't1', output: 'boom', isError: true },
    );
    expect(s.tools.get('t1')!.status).toBe('error');
  });

  it('queues approvals and resolves them via the local action (§4)', () => {
    let s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 't1', toolName: 'runCommand', input: { cmd: 'pnpm test' } },
      {
        kind: 'tool-approval-required',
        runId: 'r1',
        agentId: 'orch',
        toolCallId: 't1',
        toolName: 'runCommand',
        input: { cmd: 'pnpm test' },
        grantScope: 'pnpm *',
      },
    );
    expect(s.pending).toHaveLength(1);
    expect(s.tools.get('t1')!.status).toBe('approval');

    s = reduceTrace(s, { kind: '@approval-decision', toolCallId: 't1', decision: 'session' });
    expect(s.pending).toHaveLength(0);
    expect(s.tools.get('t1')!.granted).toBe('session');
    // a "本任务放行" toast is raised
    expect(s.toasts.some((t) => t.text.includes('pnpm *'))).toBe(true);
  });

  it('rejecting an approval marks the tool node as errored', () => {
    let s = run({
      kind: 'tool-approval-required',
      runId: 'r1',
      agentId: 'orch',
      toolCallId: 't9',
      toolName: 'runCommand',
      input: {},
      grantScope: 'rm *',
    });
    s = reduceTrace(s, { kind: '@approval-decision', toolCallId: 't9', decision: 'reject' });
    expect(s.tools.get('t9')!.status).toBe('error');
    expect(s.pending).toHaveLength(0);
  });

  it('queues an askUserQuestion and clears it on answer (§4)', () => {
    let s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'q1', toolName: 'askUserQuestion', input: {} },
      {
        kind: 'user-question-required',
        runId: 'r1',
        agentId: 'orch',
        questionId: 'q1',
        questions: [
          { question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        ],
      },
    );
    expect(s.questions).toHaveLength(1);
    expect(s.tools.get('q1')!.status).toBe('question');

    s = reduceTrace(s, { kind: '@answer-question', questionId: 'q1', cancelled: false });
    expect(s.questions).toHaveLength(0);
    expect(s.tools.get('q1')!.status).toBe('running');

    // the tool-result then folds the node to ok
    s = reduceTrace(s, { kind: 'tool-result', runId: 'r1', agentId: 'orch', toolCallId: 'q1', output: { answers: [] } });
    expect(s.tools.get('q1')!.status).toBe('ok');
  });

  it('creates the question node defensively if no tool-call preceded it', () => {
    const s = run({
      kind: 'user-question-required',
      runId: 'r1',
      agentId: 'orch',
      questionId: 'q2',
      questions: [{ question: 'Go?', header: 'Go', multiSelect: false, options: [{ label: 'Y' }, { label: 'N' }] }],
    });
    expect(s.questions).toHaveLength(1);
    expect(s.tools.get('q2')!.toolName).toBe('askUserQuestion');
    expect(s.tools.get('q2')!.status).toBe('question');
  });

  it('nests sub-agents under their parent (§3.1) and flattens with depth', () => {
    const s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'planning' },
      { kind: 'sub-agent-start', runId: 'r1', parentAgentId: 'orch', agentId: 'sub1', role: 'researcher' },
      { kind: 'tool-call', runId: 'r1', agentId: 'sub1', toolCallId: 't2', toolName: 'httpFetch', input: {} },
      { kind: 'sub-agent-finish', runId: 'r1', agentId: 'sub1', summary: '3 findings' },
    );
    const root = s.agents.get('orch')! as AgentItem;
    const sub = s.agents.get('sub1')! as AgentItem;
    expect(root.children).toContain(sub);
    expect(sub.status).toBe('done');
    expect(sub.summary).toBe('3 findings');

    const rows = flattenTrace(s);
    const subRow = rows.find((r) => r.item === sub)!;
    expect(subRow.depth).toBe(1);
    const toolRow = rows.find((r) => r.item.kind === 'tool')!;
    expect(toolRow.depth).toBe(2); // nested under the sub-agent
  });

  it('tracks session usage totals from the usage event (§2.1)', () => {
    const s = run({
      kind: 'usage',
      runId: 'r1',
      agentId: 'orch',
      usage,
      totalUsage: { inputTokens: 1000, outputTokens: 240, totalTokens: 1240, reasoningTokens: 10, cachedInputTokens: 5 },
      cost: 0.031,
    });
    expect(s.usage.totalTokens).toBe(1240);
    expect(s.usage.cost).toBeCloseTo(0.031);
  });

  it('records a compaction marker and emits a toast on end (§5.5 / §2.3)', () => {
    const s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'x' },
      { kind: 'compaction-start', runId: 'r1', reason: 'auto' },
      {
        kind: 'compaction-end',
        runId: 'r1',
        summaryEntryId: 'e1',
        firstKeptEntryId: 'e2',
        tokensBefore: 150000,
        tokensAfter: 4000,
      },
    );
    const root = s.agents.get('orch')!;
    const comp = root.children.find((c) => c.kind === 'compaction');
    expect(comp).toMatchObject({ done: true, tokensBefore: 150000, tokensAfter: 4000 });
    expect(s.compaction?.active).toBe(false);
    expect(s.toasts.some((t) => t.text.includes('→'))).toBe(true);
  });

  it('routes MCP errors to a persistent list, not run failure (§9.3)', () => {
    const s = run({ kind: 'error', runId: 'mcp', message: "MCP 'jira': connect failed" });
    expect(s.mcpErrors).toHaveLength(1);
    expect(s.status).not.toBe('error');
  });

  it('treats a sandbox-fallback notice as a non-fatal warning, not a run error (§4.1)', () => {
    const s = run({ kind: 'error', runId: 'sandbox', message: 'landstrip 未安装，已切换为无沙箱执行' });
    expect(s.status).not.toBe('error');
    const toast = s.toasts.find((t) => t.text.includes('无沙箱执行'));
    expect(toast).toMatchObject({ level: 'warning', persistent: true });
  });

  it('marks a real error and raises a persistent toast', () => {
    const s = run({ kind: 'error', runId: 'r1', message: 'provider rate limited' });
    expect(s.status).toBe('error');
    expect(s.lastError).toBe('provider rate limited');
    expect(s.toasts.find((t) => t.persistent)).toBeTruthy();
  });

  it('finishes a run and marks the root agent done', () => {
    const s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'done' },
      { kind: 'run-finish', runId: 'r1', finishReason: 'stop' },
    );
    expect(s.status).toBe('finished');
    expect(s.agents.get('orch')!.status).toBe('done');
  });
});

describe('fmtTok', () => {
  it('formats token counts compactly', () => {
    expect(fmtTok(940)).toBe('940');
    expect(fmtTok(12400)).toBe('12.4k');
    expect(fmtTok(1_500_000)).toBe('1.5M');
  });
});

describe('reconstructTrace (cli-ui §4.6 — history on switch)', () => {
  it('rebuilds user/assistant text + tool call/result from the HEAD path', () => {
    const tree: SessionTree = {
      rootId: 'e1',
      headId: 'e2',
      labels: {},
      nodes: {
        e1: { type: 'entry', id: 'e1', kind: 'user', content: [{ type: 'text', text: 'hi' }], ts: 0 },
        e2: {
          type: 'entry',
          id: 'e2',
          parentId: 'e1',
          kind: 'assistant',
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool-call', toolCallId: 't1', toolName: 'readFile', input: { path: 'a.ts' } },
            { type: 'tool-result', toolCallId: 't1', output: '10 lines' },
          ],
          ts: 1,
        },
      },
    };
    const s = reconstructTrace(tree);
    const root = s.agents.get('orch')!; // live orchestrator id, so live events append here
    expect(root.children[0]).toMatchObject({ kind: 'text', text: 'hi', speaker: 'user' });
    expect(root.children[1]).toMatchObject({ kind: 'text', text: 'working', speaker: 'assistant' });
    const tool = root.children[2] as ToolItem;
    expect(tool).toMatchObject({ kind: 'tool', toolName: 'readFile', status: 'ok', output: '10 lines' });
    expect(s.status).toBe('finished');
  });

  it('stops at the compaction summary baseline (pre-compaction entries excluded)', () => {
    const tree: SessionTree = {
      rootId: 'e1',
      headId: 'e3',
      labels: {},
      nodes: {
        e1: { type: 'entry', id: 'e1', kind: 'user', content: [{ type: 'text', text: 'old prompt' }], ts: 0 },
        e2: {
          type: 'entry',
          id: 'e2',
          parentId: 'e1',
          kind: 'summary',
          content: [{ type: 'text', text: 'summary' }],
          summary: { reason: 'threshold', firstKeptEntryId: 'e3', tokensBefore: 150000, tokensAfter: 4000 },
          ts: 1,
        },
        e3: { type: 'entry', id: 'e3', parentId: 'e2', kind: 'assistant', content: [{ type: 'text', text: 'after' }], ts: 2 },
      },
    };
    const s = reconstructTrace(tree);
    const root = s.agents.get('orch')!;
    expect(root.children[0]).toMatchObject({ kind: 'compaction', tokensBefore: 150000, tokensAfter: 4000, done: true });
    expect(root.children[1]).toMatchObject({ kind: 'text', text: 'after' });
    expect(JSON.stringify(s)).not.toContain('old prompt'); // pre-baseline entry dropped
  });

  it('rebuilds persisted reasoning parts as a reasoning block (§2.2)', () => {
    const tree: SessionTree = {
      rootId: 'e1',
      headId: 'e2',
      labels: {},
      nodes: {
        e1: { type: 'entry', id: 'e1', kind: 'user', content: [{ type: 'text', text: 'hi' }], ts: 0 },
        e2: {
          type: 'entry',
          id: 'e2',
          parentId: 'e1',
          kind: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking…' },
            { type: 'text', text: 'done' },
          ],
          ts: 1,
        },
      },
    };
    const root = reconstructTrace(tree).agents.get('orch')!;
    expect(root.children[1]).toMatchObject({ kind: 'text', text: 'thinking…', speaker: 'reasoning' });
    expect(root.children[2]).toMatchObject({ kind: 'text', text: 'done', speaker: 'assistant' });
  });

  it('returns an empty trace for an empty session tree', () => {
    const s = reconstructTrace({ nodes: {}, labels: {} });
    expect(flattenTrace(s)).toHaveLength(0);
  });
});
