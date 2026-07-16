import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModelsDevIndex, ModelsDevStore } from '../src/models/models-dev.js';
import { ModelMetaRegistry, FALLBACK_META } from '../src/models/meta.js';

const CATALOG = {
  openai: {
    models: {
      'gpt-4.1': {
        limit: { context: 1_000_000, output: 32_000 },
        cost: { input: 2, output: 8, cache_read: 0.5 },
        tool_call: true,
        modalities: { input: ['text', 'image'] },
      },
    },
  },
  deepseek: {
    models: {
      'deepseek-reasoner': { limit: { context: 128_000, output: 8_000 }, reasoning: true },
      'no-limit-model': { cost: { input: 1, output: 2 } }, // unusable → excluded
    },
  },
};

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, json: async () => body, text: async () => text } as unknown as Response;
}

describe('buildModelsDevIndex (agent §2.6)', () => {
  it('maps context/output/pricing and capabilities, keyed by ref', () => {
    const idx = buildModelsDevIndex(CATALOG as never);
    const m = idx.lookup('openai:gpt-4.1')!;
    expect(m).toMatchObject({
      ref: 'openai:gpt-4.1',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      price: { input: 2, output: 8, cachedInput: 0.5 },
    });
    expect(m.capabilities).toEqual(expect.arrayContaining(['tool_call', 'image']));
  });

  it('maps pdf + audio input modalities to capabilities (multimodal §3.1)', () => {
    const idx = buildModelsDevIndex({
      acme: { models: { 'omni-1': { limit: { context: 200_000 }, modalities: { input: ['text', 'image', 'pdf', 'audio'] } } } },
    } as never);
    expect(idx.lookup('acme:omni-1')!.capabilities).toEqual(expect.arrayContaining(['image', 'pdf', 'audio']));
  });

  it('exposes pdf + image on the Claude built-in meta; discoverable GPT is not built-in (multimodal §3.1)', () => {
    const caps = new ModelMetaRegistry().get('anthropic:claude-sonnet-4.5').capabilities ?? [];
    expect(caps).toEqual(expect.arrayContaining(['image', 'pdf']));
    // openai is discoverable, so it's intentionally absent from the built-in set
    // (its meta comes from models.dev); without a resolver it falls back, no caps.
    expect(new ModelMetaRegistry().has('openai:gpt-4.1')).toBe(false);
  });

  it('falls back to a bare model-id match when the provider id differs', () => {
    const idx = buildModelsDevIndex(CATALOG as never);
    // a custom-named openai-compatible provider ("ds") still resolves by model id
    const m = idx.lookup('ds:deepseek-reasoner')!;
    expect(m.contextWindow).toBe(128_000);
    expect(m.ref).toBe('ds:deepseek-reasoner'); // ref reflects the query, not the source
    expect(m.capabilities).toContain('reasoning');
  });

  it('prefers the normalized vendor provider over an arbitrary router (real context)', () => {
    // A router lists `glm-5.2` FIRST at a derated 200k; the vendor `zai` lists it
    // at its true 1M. Our provider id `z.ai` normalizes to `zai` and must win over
    // the bare-model-id "first router wins" fallback.
    const catalog = {
      'routing-run': { models: { 'glm-5.2': { limit: { context: 200_000 } } } },
      zai: { models: { 'glm-5.2': { limit: { context: 1_000_000 } } } },
    };
    const idx = buildModelsDevIndex(catalog as never);
    expect(idx.lookup('z.ai:glm-5.2')!.contextWindow).toBe(1_000_000);
    // An unmatched custom provider still falls through to the bare-id (router) value.
    expect(idx.lookup('myproxy:glm-5.2')!.contextWindow).toBe(200_000);
  });

  it('excludes entries with no context window and returns undefined for unknowns', () => {
    const idx = buildModelsDevIndex(CATALOG as never);
    expect(idx.lookup('deepseek:no-limit-model')).toBeUndefined();
    expect(idx.lookup('openai:does-not-exist')).toBeUndefined();
    expect(idx.size).toBe(2); // gpt-4.1 + deepseek-reasoner
  });
});

describe('ModelsDevStore (disk cache + refresh)', () => {
  const cacheFile = (): string => join(mkdtempSync(join(tmpdir(), 'zt-md-')), 'models-dev.json');

  it('fetches when cache is missing, writes it, and serves a populated index', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(CATALOG));
    const store = new ModelsDevStore(cacheFile(), { fetchImpl: fetchImpl as never, now: () => 1000 });
    expect(store.index().size).toBe(0); // nothing cached yet
    await store.refresh();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(store.index().lookup('openai:gpt-4.1')?.contextWindow).toBe(1_000_000);
  });

  it('skips the network when the cache is fresh, refetches once stale', async () => {
    const file = cacheFile();
    const fetchImpl = vi.fn(async () => jsonResponse(CATALOG));
    let now = 0;
    const store = new ModelsDevStore(file, { fetchImpl: fetchImpl as never, now: () => now, ttlMs: 1000 });
    await store.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 500; // within TTL
    await store.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now = 2000; // past TTL
    await store.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('is silent on fetch failure (keeps falling back to built-ins)', async () => {
    const store = new ModelsDevStore(cacheFile(), {
      fetchImpl: (async () => ({ ok: false, status: 503 }) as Response) as never,
    });
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(store.index().size).toBe(0);
  });
});

describe('ModelMetaRegistry external resolver precedence (agent §2.6)', () => {
  it('uses built-ins first, then the external catalog, then FALLBACK', () => {
    const reg = new ModelMetaRegistry();
    reg.setExternalResolver(buildModelsDevIndex(CATALOG as never).lookup);

    // built-in wins (curated)
    expect(reg.get('anthropic:claude-sonnet-4.5').contextWindow).toBe(200_000);
    // external fills a model with no built-in entry
    const ext = reg.get('openai:gpt-4.1');
    expect(ext.contextWindow).toBe(1_000_000);
    expect(reg.has('openai:gpt-4.1')).toBe(true);
    expect(reg.hasPrice('openai:gpt-4.1')).toBe(true);
    // truly unknown → fallback
    expect(reg.get('mystery:model-x').contextWindow).toBe(FALLBACK_META.contextWindow);
    expect(reg.has('mystery:model-x')).toBe(false);
  });
});
