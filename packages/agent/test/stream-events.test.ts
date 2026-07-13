import { describe, it, expect, vi } from 'vitest';
import type { AgentStreamEvent } from '@dami-sg/agent-contract';
import { consumeStreamPart, createPartSink, type StreamPart } from '../src/runtime/stream-events.js';

function drive(parts: StreamPart[], hooks?: Parameters<typeof consumeStreamPart>[5]) {
  const events: AgentStreamEvent[] = [];
  const sink = createPartSink();
  for (const p of parts) consumeStreamPart((e) => events.push(e), 'r1', 'orch', p, sink, hooks);
  return { events, sink };
}

describe('consumeStreamPart — reasoning normalization (agent §2.2)', () => {
  it('emits reasoning-delta events and persists a coalesced reasoning part', () => {
    const { events, sink } = drive([
      { type: 'reasoning-delta', text: 'let me ' },
      { type: 'reasoning-delta', text: 'think' },
      { type: 'text-delta', text: 'the answer' },
    ]);
    const reasoning = events.filter((e) => e.kind === 'reasoning-delta');
    expect(reasoning).toHaveLength(2);
    // reasoning persisted as one coalesced part, separate from the answer text
    expect(sink.parts).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: 'the answer' },
    ]);
    // the answer text is clean — no <think> tags leaked into it
    expect(sink.text).toBe('the answer');
  });

  it('routes finish-step usage to the onStepUsage hook', () => {
    const onStepUsage = vi.fn();
    const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 };
    const { events } = drive([{ type: 'finish-step', usage }], { onStepUsage });
    expect(onStepUsage).toHaveBeenCalledWith(usage);
    // finish-step is accounting-only; it produces no trace event itself
    expect(events).toHaveLength(0);
  });

  it('still maps tool-call / tool-result parts unchanged', () => {
    const { events } = drive([
      { type: 'tool-call', toolCallId: 't1', toolName: 'readFile', input: { path: 'a.ts' } },
      { type: 'tool-result', toolCallId: 't1', output: 'ok' },
    ]);
    expect(events.map((e) => e.kind)).toEqual(['tool-call', 'tool-result']);
  });
});
