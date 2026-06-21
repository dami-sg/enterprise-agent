/**
 * Context compaction end-to-end (agent §5.5). The unit tests in core.test.ts
 * cover only the *decision* helpers (`crossesThreshold`, `isContextOverflowError`)
 * and storage.test.ts covers the summary-ancestor path cut. They never RAN the
 * pipeline: `Compactor.summarize()` and the Session loop that wires it in were
 * untested. These tests drive the real thing:
 *   1. `Compactor.summarize()` directly — message split, return shape, passthrough.
 *   2. Threshold compaction through a live `Session.send()` turn (proactive path).
 *   3. Overflow fallback through `Session.send()` (the reactive safety net + retry).
 *   4. Manual compaction via `Session.compactManual()`.
 */
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { makeHarness } from './helpers/harness.js';
import { Session as RuntimeSession } from '../src/runtime/session.js';
import { Compactor, RECENT_TAIL } from '../src/runtime/compactor.js';
import type { ModelMeta } from '@enterprise-agent/agent-contract';

const MODEL_REF = 'mock:mock-model';

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

/** v6 provider usage is nested (`inputTokens.total`); a flat number reads as 0. */
function v3usage(input: number, output = 5) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function textParts(text: string, inputTokens: number): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: v3usage(inputTokens) as never },
  ];
}

/** A doGenerate that always returns `summaryText` — backs `Compactor.summarize`. */
function summaryGen(summaryText: string) {
  return async () => ({
    content: [{ type: 'text' as const, text: summaryText }],
    finishReason: 'stop' as const,
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    warnings: [],
  });
}

function makeSession(h: ReturnType<typeof makeHarness>): RuntimeSession {
  return new RuntimeSession(h.services, h.store, {
    goal: 'g',
    buildSkillCatalog: () => '',
    maxSteps: 6,
    compactRatio: 0.9,
    orchestratorModelRef: MODEL_REF,
  });
}

// ---------------------------------------------------------------------------

describe('Compactor.summarize() (agent §5.5)', () => {
  it('folds all-but-the-recent-tail into one summary message, preserving the tail', async () => {
    let seenPrompt = '';
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'm',
      doGenerate: async (opts) => {
        seenPrompt = JSON.stringify(opts.prompt);
        return {
          content: [{ type: 'text', text: 'DENSE SUMMARY' }],
          finishReason: 'stop',
          usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
          warnings: [],
        };
      },
    });

    // 1 system + 9 turns. tail = last RECENT_TAIL(6); toSummarize = the first 4.
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'EARLY_FIRST' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 't4' },
      { role: 'user', content: 't5' },
      { role: 'assistant', content: 't6' },
      { role: 'user', content: 't7' },
      { role: 'assistant', content: 't8' },
      { role: 'user', content: 'TAIL_LAST' },
    ];
    const meta = { ref: 'm', contextWindow: 1000, maxOutputTokens: 100 } as ModelMeta;

    const result = await new Compactor(model).summarize(messages, meta, 12345);

    // Return shape: [system, summary, ...recent tail].
    expect(result.newMessages).toHaveLength(2 + RECENT_TAIL);
    expect(result.newMessages[0]).toEqual(messages[0]); // system kept verbatim
    expect(result.newMessages[1]).toEqual({
      role: 'user',
      content: '[Compacted context summary]\nDENSE SUMMARY',
    });
    expect(result.newMessages.slice(2)).toEqual(messages.slice(-RECENT_TAIL));

    // tokensBefore is the provider figure passed in (no estimation); tokensAfter
    // is the rough text/4 estimate until the next provider report.
    expect(result.summaryText).toBe('DENSE SUMMARY');
    expect(result.tokensBefore).toBe(12345);
    expect(result.tokensAfter).toBe(Math.round('DENSE SUMMARY'.length / 4));

    // Only the pre-tail messages were sent to the summarizer.
    expect(seenPrompt).toContain('EARLY_FIRST');
    expect(seenPrompt).not.toContain('TAIL_LAST');
  });

  it('keeps at least one message to summarize when below the tail size', async () => {
    const model = new MockLanguageModelV3({ provider: 'mock', modelId: 'm', doGenerate: summaryGen('S') });
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'only' },
    ];
    const result = await new Compactor(model).summarize(messages, {} as ModelMeta, 7);
    // system + summary + the whole (sub-tail) history kept as the tail.
    expect(result.newMessages[0]).toEqual(messages[0]);
    expect(result.newMessages[1].content).toContain('[Compacted context summary]');
    expect(result.tokensBefore).toBe(7);
  });
});

describe('threshold compaction fires inside a live turn (agent §5.5 proactive)', () => {
  it('crossing the input ceiling mid-turn rewrites the next step and appends a summary entry', async () => {
    // Step 1 calls a read-only tool (no approval) and reports input tokens above
    // the ceiling, so the threshold flag is set; step 2's prepareStep compacts.
    let stream = 0;
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => {
        const n = stream++;
        if (n === 0) {
          return {
            stream: streamOf([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'tc-time', toolName: 'getCurrentTime', input: '{}' },
              { type: 'finish', finishReason: 'tool-calls', usage: v3usage(900) as never },
            ]),
          };
        }
        return { stream: streamOf(textParts('all done', 50)) };
      },
      doGenerate: summaryGen('compacted: user asked for the time'),
    });

    const h = makeHarness({ defaultModel: model });
    // Small window so 900 input tokens clears the 0.9 ceiling: usable = 1000−100,
    // threshold = 900 * 0.9 = 810.
    h.services.meta.register({ ref: MODEL_REF, contextWindow: 1000, maxOutputTokens: 100 });

    const session = makeSession(h);
    await session.send('what time is it?').completion;

    const start = h.events.find((e) => e.kind === 'compaction-start') as any;
    expect(start).toBeTruthy();
    expect(start.reason).toBe('threshold');

    const end = h.events.find((e) => e.kind === 'compaction-end') as any;
    expect(end).toBeTruthy();

    // A real summary entry landed on the tree, carrying the provider token figure.
    const summary = h.store.getEntry(end.summaryEntryId);
    expect(summary?.kind).toBe('summary');
    expect(summary?.summary?.reason).toBe('threshold');
    expect(summary?.summary?.tokensBefore).toBe(900);

    // The turn still completed cleanly after the rewrite.
    const finish = h.events.find((e) => e.kind === 'run-finish') as any;
    expect(finish.finishReason).not.toBe('error');
    h.cleanup();
  });
});

describe('overflow fallback compacts and retries once (agent §5.5 reactive)', () => {
  it('a provider context-overflow error triggers emergency compaction, then the retry succeeds', async () => {
    // The stream errors with an overflow message until the prompt carries a
    // compaction marker (i.e. after summarize rewrote the messages), then it
    // recovers. (A stream that *errors* surfaces as a throw the session catches;
    // a rejected doStream would only become a non-throwing error part.)
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async (opts) => {
        const prompt = JSON.stringify(opts.prompt);
        const compacted = prompt.includes('Compacted context summary') || prompt.includes('Earlier context summary');
        if (!compacted) {
          return {
            stream: new ReadableStream<LanguageModelV3StreamPart>({
              start(c) {
                c.error(new Error('prompt is too long: 250000 tokens'));
              },
            }),
          };
        }
        return { stream: streamOf(textParts('recovered after compaction', 40)) };
      },
      doGenerate: summaryGen('emergency summary of the conversation so far'),
    });

    const h = makeHarness({ defaultModel: model });
    const session = makeSession(h);
    await session.send('a very long prompt that overflows the window').completion;

    const start = h.events.find((e) => e.kind === 'compaction-start') as any;
    expect(start?.reason).toBe('overflow');

    const end = h.events.find((e) => e.kind === 'compaction-end') as any;
    const summary = h.store.getEntry(end.summaryEntryId);
    expect(summary?.summary?.reason).toBe('overflow');

    // The retried step produced the assistant's recovery text and the turn ended OK.
    const text = h.events
      .filter((e: any) => e.kind === 'text-delta')
      .map((e: any) => e.text)
      .join('');
    expect(text).toContain('recovered after compaction');
    const finish = h.events.find((e) => e.kind === 'run-finish') as any;
    expect(finish.finishReason).not.toBe('error');
    h.cleanup();
  });
});

describe('manual compaction (agent §5.5 manual)', () => {
  it('compactManual summarizes the path, appends a manual summary, and re-anchors the tail', async () => {
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doStream: async () => ({ stream: streamOf(textParts('hello back', 20)) }),
      doGenerate: summaryGen('manual checkpoint summary'),
    });
    const h = makeHarness({ defaultModel: model });
    const session = makeSession(h);

    // A turn first so the active path has >= 2 entries to compact.
    await session.send('hello').completion;

    await session.compactManual();

    const start = h.events.find((e) => e.kind === 'compaction-start' && (e as any).reason === 'manual') as any;
    expect(start).toBeTruthy();
    const end = h.events.find((e) => e.kind === 'compaction-end' && e.runId === 'manual') as any;
    expect(end).toBeTruthy();

    const summary = h.store.getEntry(end.summaryEntryId);
    expect(summary?.kind).toBe('summary');
    expect(summary?.summary?.reason).toBe('manual');
    expect(summary?.content?.[0]).toMatchObject({ type: 'text', text: 'manual checkpoint summary' });

    // The active path is re-anchored under the summary (summary then the tail).
    const path = h.store.getPath();
    const sIdx = path.findIndex((e) => e.id === summary?.id);
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(path.slice(sIdx + 1).every((e) => e.kind !== 'summary')).toBe(true);
    h.cleanup();
  });

  it('is a no-op when the path is too short to compact', async () => {
    const model = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: summaryGen('unused'),
    });
    const h = makeHarness({ defaultModel: model });
    const session = makeSession(h);
    await session.compactManual();
    expect(h.events.some((e) => e.kind === 'compaction-start')).toBe(false);
    h.cleanup();
  });
});
