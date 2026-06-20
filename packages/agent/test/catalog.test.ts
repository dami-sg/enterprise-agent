import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/models/catalog.js';
import { ModelMetaRegistry } from '../src/models/meta.js';
import { EnvKeyStore } from '../src/config/keychain.js';
import type { ProviderConfig } from '@enterprise-agent/agent-contract';

function cacheDir(): (id: string) => string {
  const dir = mkdtempSync(join(tmpdir(), 'ea-catalog-'));
  return (id) => join(dir, `models-${id}.json`);
}

function jsonOk(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

/** A `fetch` stub returning `body`, counting calls. */
function stubFetch(body: unknown) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    return jsonOk(body);
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const openai: ProviderConfig = { id: 'openai', kind: 'openai', keyRef: 'openai.key', enabled: true };

describe('ModelCatalog — model discovery (agent §2.6)', () => {
  it('merges dynamic ids with static known models (union, not replace)', async () => {
    const keychain = new EnvKeyStore();
    keychain.set('openai.key', 'sk-test');
    const { impl } = stubFetch({ data: [{ id: 'gpt-4.1' }, { id: 'gpt-4o' }] });
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), keychain, { fetchImpl: impl });

    const res = await cat.list(openai);

    const refs = res.models.map((m) => m.ref);
    // dynamic gpt-4.1 + gpt-4o, plus static-only gpt-4.1-mini (BUILTIN_MODEL_META)
    expect(refs).toContain('openai:gpt-4.1');
    expect(refs).toContain('openai:gpt-4o');
    expect(refs).toContain('openai:gpt-4.1-mini');
    expect(res.models.find((m) => m.ref === 'openai:gpt-4.1')).toMatchObject({ source: 'dynamic', hasMeta: true });
    expect(res.models.find((m) => m.ref === 'openai:gpt-4o')).toMatchObject({ source: 'dynamic', hasMeta: false });
    expect(res.models.find((m) => m.ref === 'openai:gpt-4.1-mini')).toMatchObject({ source: 'static', hasMeta: true });
    expect(res.cached).toBe(false);
    expect(res.error).toBeUndefined();
  });

  it('parses the Google response shape (models[].name)', async () => {
    const keychain = new EnvKeyStore();
    keychain.set('g.key', 'k');
    const { impl } = stubFetch({ models: [{ name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-2.5-flash' }] });
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), keychain, { fetchImpl: impl });

    const res = await cat.list({ id: 'google', kind: 'google', keyRef: 'g.key', enabled: true });

    expect(res.models.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('returns static-only for anthropic without hitting the network', async () => {
    const failFetch = (async () => {
      throw new Error('should not fetch anthropic');
    }) as unknown as typeof fetch;
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), new EnvKeyStore(), { fetchImpl: failFetch });

    const res = await cat.list({ id: 'anthropic', kind: 'anthropic', enabled: true });

    expect(res.fetchedAt).toBe(0);
    expect(res.models.every((m) => m.source === 'static')).toBe(true);
    expect(res.models.length).toBeGreaterThan(0); // claude-* from BUILTIN_MODEL_META
  });

  it('skips the call for a cloud kind with no key, falling back to static', async () => {
    const { impl, calls } = stubFetch({ data: [{ id: 'x' }] });
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), new EnvKeyStore(), { fetchImpl: impl });

    const res = await cat.list({ id: 'openai', kind: 'openai', enabled: true }); // no keyRef

    expect(calls()).toBe(0);
    expect(res.error).toBe('no api key');
    expect(res.models.every((m) => m.source === 'static')).toBe(true);
  });

  it('still fetches a local openai-compatible server without a key', async () => {
    const { impl, calls } = stubFetch({ data: [{ id: 'llama3' }] });
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), new EnvKeyStore(), { fetchImpl: impl });

    const res = await cat.list({
      id: 'ollama',
      kind: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      enabled: true,
    });

    expect(calls()).toBe(1);
    expect(res.models.map((m) => m.id)).toContain('llama3');
  });

  it('falls back to static silently when the fetch fails', async () => {
    const keychain = new EnvKeyStore();
    keychain.set('openai.key', 'sk');
    const badFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), keychain, { fetchImpl: badFetch });

    const res = await cat.list(openai);

    expect(res.error).toBe('HTTP 500');
    expect(res.models.every((m) => m.source === 'static')).toBe(true);
  });

  it('serves from cache on the second call, and refresh bypasses it', async () => {
    const keychain = new EnvKeyStore();
    keychain.set('openai.key', 'sk');
    const { impl, calls } = stubFetch({ data: [{ id: 'gpt-4.1' }] });
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), keychain, { fetchImpl: impl });

    await cat.list(openai);
    const second = await cat.list(openai);
    expect(calls()).toBe(1);
    expect(second.cached).toBe(true);

    await cat.list(openai, true); // refresh
    expect(calls()).toBe(2);
  });

  it('refetches once the cache TTL expires', async () => {
    const keychain = new EnvKeyStore();
    keychain.set('openai.key', 'sk');
    const { impl, calls } = stubFetch({ data: [{ id: 'gpt-4.1' }] });
    let clock = 0;
    const cat = new ModelCatalog(cacheDir(), new ModelMetaRegistry(), keychain, {
      fetchImpl: impl,
      now: () => clock,
      ttlMs: 1000,
    });

    await cat.list(openai); // fetch @ t=0
    clock = 500;
    await cat.list(openai); // within TTL → cache
    expect(calls()).toBe(1);
    clock = 1500;
    await cat.list(openai); // past TTL → refetch
    expect(calls()).toBe(2);
  });
});
