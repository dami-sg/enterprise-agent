import { describe, it, expect } from 'vitest';
import { streamText } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { withReasoning } from '../src/models/registry.js';

/** Stream a model that emits `<tag>thinking</tag>answer` and split the channels. */
async function split(tag: string): Promise<{ reasoning: string; text: string }> {
  const chunks = [
    { type: 'text-start' as const, id: '0' },
    { type: 'text-delta' as const, id: '0', delta: `<${tag}>thinking hard` },
    { type: 'text-delta' as const, id: '0', delta: ` step by step</${tag}>` },
    { type: 'text-delta' as const, id: '0', delta: 'final answer' },
    { type: 'text-end' as const, id: '0' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  ];
  const base = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
  const res = streamText({ model: withReasoning(base), prompt: 'hi' });
  let reasoning = '';
  let text = '';
  for await (const part of res.fullStream) {
    if (part.type === 'reasoning-delta') reasoning += part.text;
    if (part.type === 'text-delta') text += part.text;
  }
  return { reasoning, text };
}

describe('withReasoning — normalizes inline thinking tags (agent §2.2)', () => {
  it('extracts <think> tags (DeepSeek / Qwen style)', async () => {
    expect(await split('think')).toEqual({ reasoning: 'thinking hard step by step', text: 'final answer' });
  });

  it('extracts <mm:think> tags (MiniMax style) — no stray tag leaks into the answer', async () => {
    const { reasoning, text } = await split('mm:think');
    expect(reasoning).toBe('thinking hard step by step');
    expect(text).toBe('final answer');
    expect(text).not.toContain('mm:think');
  });

  it('leaves a model with no thinking tags untouched', async () => {
    const chunks = [
      { type: 'text-start' as const, id: '0' },
      { type: 'text-delta' as const, id: '0', delta: 'just an answer' },
      { type: 'text-end' as const, id: '0' },
      { type: 'finish' as const, finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ];
    const base = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) });
    const res = streamText({ model: withReasoning(base), prompt: 'hi' });
    let text = '';
    for await (const part of res.fullStream) if (part.type === 'text-delta') text += part.text;
    expect(text).toBe('just an answer');
  });
});
