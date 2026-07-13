/**
 * Cross-session memory capability (memory §1–§5). Covers the two Phase-1
 * deliverables: the config resolution + scope derivation (memory §4/§5), and
 * the three turn-loop hooks driven through a real `Session.send()` against a
 * stub `MemoryPort` (memory §3):
 *   ① retrieve-inject — recalled snippets reach the model's system prompt.
 *   ② capture — the completed exchange is fed back, fire-and-forget.
 *   ③ maintain — the no-op-safe call site invokes the port.
 * Plus the invariants that matter: disabled = zero behavior change, and the
 * retrieve hook fails open on backend error/timeout.
 */
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { MemoryHit, MemoryPort, MemoryScope } from '@dami-sg/agent-contract';
import { ConfigStore, resolveMemoryScope } from '../src/config/store.js';
import { createPaths } from '../src/config/paths.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.js';
import { Session as RuntimeSession } from '../src/runtime/session.js';

const MODEL_REF = 'mock:mock-model';

function streamOf(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

function textParts(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  ];
}

/** A model that records the system prompt it was handed, then replies `reply`. */
function recordingModel(reply: string): { model: MockLanguageModelV3; seen: () => string } {
  let seenPrompt = '';
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock-model',
    doStream: async (opts) => {
      seenPrompt = JSON.stringify(opts.prompt);
      return { stream: streamOf(textParts(reply)) };
    },
  });
  return { model, seen: () => seenPrompt };
}

interface StubCalls {
  retrieve: { scope: MemoryScope; query: string; topK?: number }[];
  capture: { scope: MemoryScope; roles: string[] }[];
  maintain: number;
}

function stubMemory(
  calls: StubCalls,
  opts: { hits?: MemoryHit[]; retrieveThrows?: boolean; retrieveHangsMs?: number } = {},
): MemoryPort {
  return {
    retrieve: async (scope, query, ro) => {
      calls.retrieve.push({ scope, query, topK: ro?.topK });
      if (opts.retrieveThrows) throw new Error('backend down');
      if (opts.retrieveHangsMs) await new Promise((r) => setTimeout(r, opts.retrieveHangsMs));
      return opts.hits ?? [];
    },
    capture: async (scope, payload) => {
      calls.capture.push({ scope, roles: payload.messages.map((m) => m.role) });
    },
    maintain: async () => {
      calls.maintain += 1;
    },
  };
}

/**
 * A minimal *stateful* port (unlike `stubMemory`, which only records calls):
 * stores captured texts per namespace and recalls them newest-first. Just
 * enough to prove cross-session sharing through the real turn loop — recall is
 * recency-based, not semantic.
 */
function statefulMemory(): MemoryPort {
  const store = new Map<string, string[]>();
  return {
    capture: async (scope, payload) => {
      const b = store.get(scope.namespace) ?? [];
      for (const m of payload.messages) if (m.text.trim()) b.push(m.text.trim());
      store.set(scope.namespace, b);
    },
    retrieve: async (scope, query, ro) => {
      if (!query.trim()) return [];
      const b = store.get(scope.namespace) ?? [];
      return b
        .slice()
        .reverse()
        .slice(0, ro?.topK ?? 6)
        .map((text) => ({ text }));
    },
    maintain: async () => {},
  };
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

function freshCalls(): StubCalls {
  return { retrieve: [], capture: [], maintain: 0 };
}

// ---------------------------------------------------------------------------

describe('memory config + scope resolution (memory §4/§5)', () => {
  function effFor(memory: Record<string, unknown> | undefined) {
    const home = mkdtempSync(join(tmpdir(), 'ea-mem-'));
    const cfg = new ConfigStore(createPaths(home));
    if (memory) cfg.saveSettings({ memory } as never);
    return cfg.effective(undefined, []);
  }

  it('defaults to disabled, per-user, topK 6, 1500ms (off = no behavior change)', () => {
    const eff = effFor(undefined);
    expect(eff.memoryEnabled).toBe(false);
    expect(eff.memoryScopeMode).toBe('per-user');
    expect(eff.memoryTopK).toBe(6);
    expect(eff.memoryTimeoutMs).toBe(1500);
  });

  it('reads enabled + scope + retrieve overrides from settings', () => {
    const eff = effFor({ enabled: true, scope: 'global', retrieve: { topK: 3, timeoutMs: 500 } });
    expect(eff.memoryEnabled).toBe(true);
    expect(eff.memoryScopeMode).toBe('global');
    expect(eff.memoryTopK).toBe(3);
    expect(eff.memoryTimeoutMs).toBe(500);
  });

  it('host-supplied namespace always wins over the scope mode', () => {
    expect(resolveMemoryScope({ memoryScopeMode: 'global' }, { namespace: 'u-42' })).toEqual({
      namespace: 'u-42',
    });
  });

  it('derives the namespace from the scope mode when none is supplied', () => {
    expect(resolveMemoryScope({ memoryScopeMode: 'global' }, {})).toEqual({ namespace: 'global' });
    expect(resolveMemoryScope({ memoryScopeMode: 'per-project' }, { projectSlug: 'repo' })).toEqual({
      namespace: 'repo',
    });
    expect(resolveMemoryScope({ memoryScopeMode: 'per-project' }, {})).toEqual({ namespace: 'default' });
    // per-user with no host id collapses to the single-user local store.
    expect(resolveMemoryScope({ memoryScopeMode: 'per-user' }, {})).toEqual({ namespace: 'default' });
  });
});

describe('memory turn-loop hooks (memory §3)', () => {
  const scope: MemoryScope = { namespace: 'u1' };

  it('① injects recalled snippets into the system prompt and passes scope + topK', async () => {
    const calls = freshCalls();
    const { model, seen } = recordingModel('done');
    const h = makeHarness({ defaultModel: model });
    h.services.memory = stubMemory(calls, { hits: [{ text: 'user prefers dark mode' }] });
    h.services.memoryScope = scope;
    h.services.memoryRetrieve = { topK: 4, timeoutMs: 1000 };

    await makeSession(h).send('what theme do I like?').completion;

    expect(calls.retrieve).toHaveLength(1);
    expect(calls.retrieve[0]).toMatchObject({ scope, query: 'what theme do I like?', topK: 4 });
    expect(seen()).toContain('user prefers dark mode');
  });

  it('② captures the completed user+assistant exchange under the scope', async () => {
    const calls = freshCalls();
    const { model } = recordingModel('the answer');
    const h = makeHarness({ defaultModel: model });
    h.services.memory = stubMemory(calls);
    h.services.memoryScope = scope;
    h.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };

    await makeSession(h).send('a question').completion;

    expect(calls.capture).toHaveLength(1);
    expect(calls.capture[0]).toMatchObject({ scope, roles: ['user', 'assistant'] });
  });

  it('③ maintain reaches the port via the no-op-safe call site', async () => {
    const calls = freshCalls();
    const h = makeHarness();
    h.services.memory = stubMemory(calls);
    h.services.memoryScope = scope;
    await makeSession(h).maintainMemory();
    expect(calls.maintain).toBe(1);
  });

  it('disabled (no port) = zero behavior change: turn still completes, no calls', async () => {
    const calls = freshCalls();
    const { model, seen } = recordingModel('hello');
    const h = makeHarness({ defaultModel: model });
    // No memory wired (the production default when settings.memory.enabled=false).
    await makeSession(h).send('hi').completion;
    expect(calls.retrieve).toHaveLength(0);
    expect(calls.capture).toHaveLength(0);
    expect(seen()).not.toContain('Relevant memories');
    // maintainMemory is a no-op when no port is present.
    await makeSession(h).maintainMemory();
    expect(calls.maintain).toBe(0);
  });

  it('① fails open on a backend error — the turn proceeds with no memory block', async () => {
    const calls = freshCalls();
    const { model, seen } = recordingModel('ok');
    const h = makeHarness({ defaultModel: model });
    h.services.memory = stubMemory(calls, { retrieveThrows: true });
    h.services.memoryScope = scope;
    h.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };

    await makeSession(h).send('q').completion;

    expect(calls.retrieve).toHaveLength(1); // attempted
    expect(seen()).not.toContain('Relevant memories'); // but no block injected
  });

  it('① fails open on timeout — a slow backend does not block the turn', async () => {
    const calls = freshCalls();
    const { model, seen } = recordingModel('ok');
    const h = makeHarness({ defaultModel: model });
    h.services.memory = stubMemory(calls, { retrieveHangsMs: 200, hits: [{ text: 'too late' }] });
    h.services.memoryScope = scope;
    h.services.memoryRetrieve = { topK: 6, timeoutMs: 20 };

    await makeSession(h).send('q').completion;

    expect(seen()).not.toContain('too late');
  });
});

describe('cross-session memory sharing through the turn loop (the product promise)', () => {
  it('a fact captured in one session is recalled in another sharing the namespace', async () => {
    const mem = statefulMemory();
    const acct: MemoryScope = { namespace: 'acct_alice' };

    // Session A (e.g. Telegram) captures a fact.
    const a = makeHarness({ defaultModel: recordingModel('noted').model });
    a.services.memory = mem;
    a.services.memoryScope = acct;
    a.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };
    await makeSession(a).send('My favorite genre is sci-fi').completion;

    // Session B (a different harness + store = a different channel/thread), same account.
    const b = recordingModel('here are some');
    const hb = makeHarness({ defaultModel: b.model });
    hb.services.memory = mem;
    hb.services.memoryScope = acct;
    hb.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };
    await makeSession(hb).send('what movies should I watch?').completion;

    expect(b.seen()).toContain('sci-fi'); // recalled into B's system prompt
  });

  it('a different account does not recall the fact (namespace isolation)', async () => {
    const mem = statefulMemory();

    const a = makeHarness({ defaultModel: recordingModel('noted').model });
    a.services.memory = mem;
    a.services.memoryScope = { namespace: 'acct_alice' };
    a.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };
    await makeSession(a).send('My favorite genre is sci-fi').completion;

    const b = recordingModel('hmm');
    const hb = makeHarness({ defaultModel: b.model });
    hb.services.memory = mem;
    hb.services.memoryScope = { namespace: 'acct_bob' };
    hb.services.memoryRetrieve = { topK: 6, timeoutMs: 1000 };
    await makeSession(hb).send('what movies should I watch?').completion;

    expect(b.seen()).not.toContain('sci-fi');
  });
});
