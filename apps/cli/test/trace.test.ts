import { describe, it, expect } from 'vitest';
import type { AgentStreamEvent, SessionTree } from '@enterprise-agent/agent-contract';
import {
  reduceTrace,
  reconstructTrace,
  initialTrace,
  flattenTrace,
  flattenSubAgentLog,
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
      { kind: 'sub-agent-start', runId: 'r1', parentRunId: 'r0', parentAgentId: 'orch', agentId: 'sub1', role: 'researcher' },
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

  it('records a shell-escape command and fills its output/exit code (§6.2)', () => {
    let s = run({ kind: '@shell-start', command: 'ls -la' });
    const orch = s.agents.get('orch')!;
    const shell = orch.children.find((c) => c.kind === 'shell') as Extract<typeof orch.children[number], { kind: 'shell' }>;
    expect(shell).toMatchObject({ command: 'ls -la', running: true });
    expect(shell.output).toBeUndefined();

    s = reduceTrace(s, { kind: '@shell-result', output: 'total 0\n', exitCode: 0 });
    expect(shell.running).toBe(false);
    expect(shell.output).toBe('total 0\n');
    expect(shell.exitCode).toBe(0);

    // The shell item is a flat row (a child of the orchestrator), not nested.
    expect(flattenTrace(s).some((r) => r.item === shell)).toBe(true);
  });

  it('nests a sub-agent inside its spawning delegate tool call, gated by expansion (§3.1)', () => {
    const s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'd1', toolName: 'delegateToSubAgent', input: { role: 'writer' } },
      { kind: 'sub-agent-start', runId: 'r1', parentRunId: 'r0', parentAgentId: 'orch', agentId: 'sub1', role: 'writer', toolCallId: 'd1' },
      { kind: 'text-delta', runId: 'r1', agentId: 'sub1', text: 'writing report' },
      { kind: 'sub-agent-finish', runId: 'r1', agentId: 'sub1', summary: 'done' },
    );
    const tool = s.tools.get('d1')!;
    const sub = s.agents.get('sub1')! as AgentItem;
    // The sub-agent hangs off the TOOL call, not the orchestrator.
    expect(tool.children).toContain(sub);
    expect((s.agents.get('orch') as AgentItem).children).not.toContain(sub);

    // Collapsed delegate tool → the sub-agent log is hidden.
    const collapsed = flattenTrace(s, { isToolExpanded: () => false });
    expect(collapsed.find((r) => r.item === sub)).toBeUndefined();

    // Expanded → sub-agent + its streamed text appear, nested one level under the tool.
    const expanded = flattenTrace(s, { isToolExpanded: (id) => id === 'd1' });
    const subRow = expanded.find((r) => r.item === sub)!;
    const toolRow = expanded.find((r) => r.item === tool)!;
    expect(subRow).toBeDefined();
    expect(subRow.depth).toBe(toolRow.depth + 1);
    expect(expanded.some((r) => r.item.kind === 'text' && (r.item as { text: string }).text === 'writing report')).toBe(true);

    // No gate (headless) → always included.
    expect(flattenTrace(s).find((r) => r.item === sub)).toBeDefined();
  });

  it('contains a delegate sub-agent log off the main rows for the TUI viewport (§3.1)', () => {
    const s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'd1', toolName: 'delegateToSubAgent', input: { role: 'writer' } },
      { kind: 'sub-agent-start', runId: 'r1', parentRunId: 'r0', parentAgentId: 'orch', agentId: 'sub1', role: 'writer', toolCallId: 'd1' },
      { kind: 'text-delta', runId: 'r1', agentId: 'sub1', text: 'writing report' },
    );
    const tool = s.tools.get('d1')! as ToolItem;
    const sub = s.agents.get('sub1')! as AgentItem;

    // `containSubAgent`: the sub-agent never appears in the top-level rows — the
    // delegate tool row is the only sign of it in the transcript.
    const main = flattenTrace(s, { containSubAgent: true });
    expect(main.find((r) => r.item === tool)).toBeDefined();
    expect(main.find((r) => r.item === sub)).toBeUndefined();
    expect(main.some((r) => r.item.kind === 'text' && (r.item as { text: string }).text === 'writing report')).toBe(false);

    // The viewport flatten pulls that same log out of the tool's children,
    // starting flush (depth 1) with the sub-agent's streamed text below it.
    const log = flattenSubAgentLog(tool);
    expect(log.find((r) => r.item === sub)?.depth).toBe(1);
    expect(log.some((r) => r.item.kind === 'text' && (r.item as { text: string }).text === 'writing report')).toBe(true);
  });

  it('re-homes parallel sub-agents under their own delegate tool whatever the event order (§3.1)', () => {
    // Parallel delegation races the orchestrator's stream against each sub-agent:
    // here the writer's start + streamed log arrive BEFORE its delegate tool-call
    // (d2), and the coder's content arrives BEFORE its start. Naively each would
    // parent to the orchestrator and flood the main transcript; both must end up
    // contained under their own tool.
    const s = run(
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'd1', toolName: 'delegateToSubAgent', input: { role: 'coder' } },
      // coder: content BEFORE its start
      { kind: 'text-delta', runId: 'r2', agentId: 'sub-coder', text: 'writing code' },
      { kind: 'sub-agent-start', runId: 'r2', parentRunId: 'r1', parentAgentId: 'orch', agentId: 'sub-coder', role: 'coder', toolCallId: 'd1' },
      // writer: start + log BEFORE its delegate tool-call d2
      { kind: 'sub-agent-start', runId: 'r3', parentRunId: 'r1', parentAgentId: 'orch', agentId: 'sub-writer', role: 'writer', toolCallId: 'd2' },
      { kind: 'text-delta', runId: 'r3', agentId: 'sub-writer', text: 'drafting the report' },
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'd2', toolName: 'delegateToSubAgent', input: { role: 'writer' } },
    );
    const orch = s.agents.get('orch')! as AgentItem;
    const d1 = s.tools.get('d1')! as ToolItem;
    const d2 = s.tools.get('d2')! as ToolItem;
    const coder = s.agents.get('sub-coder')! as AgentItem;
    const writer = s.agents.get('sub-writer')! as AgentItem;

    // Each sub-agent hangs under its OWN delegate tool — never the orchestrator.
    expect(d1.children).toContain(coder);
    expect(d2.children).toContain(writer);
    expect(orch.children).not.toContain(coder);
    expect(orch.children).not.toContain(writer);

    // Neither log leaks into the main (contained) rows; each viewport owns its own.
    const main = flattenTrace(s, { containSubAgent: true });
    expect(main.find((r) => r.item === coder || r.item === writer)).toBeUndefined();
    const hasText = (rows: ReturnType<typeof flattenTrace>, t: string) =>
      rows.some((r) => r.item.kind === 'text' && (r.item as { text: string }).text === t);
    expect(hasText(main, 'writing code')).toBe(false);
    expect(hasText(main, 'drafting the report')).toBe(false);
    expect(hasText(flattenSubAgentLog(d1), 'writing code')).toBe(true);
    expect(hasText(flattenSubAgentLog(d2), 'drafting the report')).toBe(true);
  });

  it('hides a sub-agent from the main rows while its delegate tool-call is still pending (§3.1)', () => {
    // The sub-agent's start + log have arrived but its delegate tool-call has
    // not yet — so it's temporarily parented to the orchestrator. Under
    // containment it must NOT render flat (no flash before it's re-homed).
    const s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'delegating in parallel…' },
      { kind: 'sub-agent-start', runId: 'r2', parentRunId: 'r1', parentAgentId: 'orch', agentId: 'sub-writer', role: 'writer', toolCallId: 'd2' },
      { kind: 'text-delta', runId: 'r2', agentId: 'sub-writer', text: 'drafting the report' },
    );
    const writer = s.agents.get('sub-writer')! as AgentItem;
    const main = flattenTrace(s, { containSubAgent: true });
    expect(main.find((r) => r.item === writer)).toBeUndefined(); // hidden, not flat
    expect(main.some((r) => r.item.kind === 'text' && (r.item as { text: string }).text === 'drafting the report')).toBe(false);
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

  it('a sub-agent run-finish does NOT end the turn — only the root run does (§3.1)', () => {
    // The orchestrator (run r1) delegates to a sub-agent (its own run r2). A
    // run-finish for the SUB run must not flip the trace to finished or mark the
    // root done while the orchestrator is still working — that would freeze the
    // spinner mid-turn. Only the root run-finish (r1) ends the turn.
    let s = run(
      { kind: 'text-delta', runId: 'r1', agentId: 'orch', text: 'delegating' },
      { kind: 'tool-call', runId: 'r1', agentId: 'orch', toolCallId: 'd1', toolName: 'delegateToSubAgent', input: { role: 'coder' } },
      { kind: 'sub-agent-start', runId: 'r2', parentRunId: 'r1', parentAgentId: 'orch', agentId: 'sub1', role: 'coder', toolCallId: 'd1' },
      { kind: 'run-finish', runId: 'r2', finishReason: 'stop' }, // the SUB run ends
    );
    expect(s.status).toBe('running'); // turn is NOT over
    expect(s.agents.get('orch')!.status).toBe('running');

    s = reduceTrace(s, { kind: 'run-finish', runId: 'r1', finishReason: 'stop' }); // root ends
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
