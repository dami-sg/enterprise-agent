/**
 * Model discovery (agent §2.6): dynamically list a provider's available model
 * ids, merge with statically-known models, cache to disk with a TTL, and fall
 * back silently on failure. Endpoint + response shape vary by provider `kind`;
 * the per-kind table lives here, NOT on `ProviderConfig`.
 */
import type {
  DiscoveredModel,
  ProviderConfig,
  ProviderKind,
  ProviderModelsResult,
} from '@dami-sg/agent-contract';
import { isLocalBase } from '@dami-sg/agent-contract';
import { readJson, writeJson } from '../util/fs.js';
import type { ModelMetaRegistry } from './meta.js';
import type { KeyStore } from '../config/keychain.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h (agent §2.6)
const FETCH_TIMEOUT_MS = 5_000;

type AuthScheme = 'bearer' | 'google';

interface KindDiscovery {
  /** Used when the provider sets no baseURL (official cloud endpoint). */
  defaultBaseURL?: string;
  /** Parse the provider's JSON response into raw model ids. */
  parse(json: unknown): string[];
  auth: AuthScheme;
  /** Cloud kinds 401 without a key; skip the call when no key & non-local. */
  requiresKey: boolean;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** OpenAI-compatible: `{ data: [{ id }] }` (agent §2.6 discovery table). */
const parseOpenAI = (json: unknown): string[] =>
  asArray((json as { data?: unknown } | null)?.data)
    .map((m) => (m as { id?: unknown })?.id)
    .filter(isNonEmptyString);

/** Google: `{ models: [{ name: "models/<id>" }] }` — different shape. */
const parseGoogle = (json: unknown): string[] =>
  asArray((json as { models?: unknown } | null)?.models)
    .map((m) => String((m as { name?: unknown })?.name ?? '').replace(/^models\//, ''))
    .filter(isNonEmptyString);

const DISCOVERY: Record<ProviderKind, KindDiscovery | null> = {
  // No models endpoint — static metadata only (agent §2.6).
  anthropic: null,
  openai: {
    defaultBaseURL: 'https://api.openai.com/v1',
    parse: parseOpenAI,
    auth: 'bearer',
    requiresKey: true,
  },
  // baseURL already carries the version prefix → `${baseURL}/models` matches
  // exactly how the SDK calls the provider (agent §2.6).
  'openai-compatible': { parse: parseOpenAI, auth: 'bearer', requiresKey: true },
  gateway: { parse: parseOpenAI, auth: 'bearer', requiresKey: true },
  google: {
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    parse: parseGoogle,
    auth: 'google',
    requiresKey: true,
  },
};

interface CacheFile {
  providerId: string;
  fetchedAt: number;
  ids: string[];
}

export interface ModelCatalogOptions {
  ttlMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for TTL tests; defaults to `Date.now`. */
  now?: () => number;
  timeoutMs?: number;
}

export class ModelCatalog {
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly cacheFileFor: (providerId: string) => string,
    private readonly meta: ModelMetaRegistry,
    private readonly keychain: KeyStore,
    opts: ModelCatalogOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /**
   * List a provider's models: fresh cache → dynamic fetch → silent fallback to
   * stale cache, then static-only. Always merged with statically-known models.
   */
  async list(provider: ProviderConfig, refresh = false): Promise<ProviderModelsResult> {
    const disc = DISCOVERY[provider.kind];
    // Kinds with no discovery endpoint (anthropic) → static metadata only.
    if (!disc) return this.staticOnly(provider.id);

    const base = (provider.baseURL ?? disc.defaultBaseURL)?.replace(/\/+$/, '');
    if (!base) return this.staticOnly(provider.id, 'no baseURL to discover from');

    if (!refresh) {
      const cached = this.readCache(provider.id);
      if (cached && this.now() - cached.fetchedAt < this.ttlMs) {
        return this.result(provider.id, cached.ids, cached.fetchedAt, true);
      }
    }

    const key = provider.keyRef ? this.keychain.get(provider.keyRef) : undefined;
    // A cloud kind without a key would 401 — skip and fall back (agent §2.6 pt.5).
    if (disc.requiresKey && !key && !isLocalBase(base)) {
      return this.fallbackWithStale(provider.id, 'no api key');
    }

    try {
      const ids = await this.fetchIds(`${base}/models`, disc, key, provider.headers);
      const at = this.now();
      writeJson(this.cacheFileFor(provider.id), {
        providerId: provider.id,
        fetchedAt: at,
        ids,
      } satisfies CacheFile);
      return this.result(provider.id, ids, at, false);
    } catch (e) {
      // Silent fallback: stale cache if any, else static-only (agent §2.6 pt.5).
      return this.fallbackWithStale(provider.id, e instanceof Error ? e.message : String(e));
    }
  }

  // -- internals --

  private result(
    providerId: string,
    dynamicIds: string[],
    fetchedAt: number,
    cached: boolean,
    error?: string,
  ): ProviderModelsResult {
    return { providerId, models: this.merge(providerId, dynamicIds), fetchedAt, cached, error };
  }

  private staticOnly(providerId: string, error?: string): ProviderModelsResult {
    return this.result(providerId, [], 0, false, error);
  }

  private fallbackWithStale(providerId: string, error: string): ProviderModelsResult {
    const stale = this.readCache(providerId);
    if (stale) return this.result(providerId, stale.ids, stale.fetchedAt, true, error);
    return this.staticOnly(providerId, error);
  }

  /** Statically-known refs for a provider, from registered ModelMeta. */
  private staticRefs(providerId: string): string[] {
    const prefix = `${providerId}:`;
    return this.meta.refs().filter((r) => r.startsWith(prefix));
  }

  /**
   * Merge static + dynamic into a sorted, de-duped list (agent §2.6: union, not
   * replace). Static seeds first so a matching dynamic id relabels source.
   */
  private merge(providerId: string, dynamicIds: string[]): DiscoveredModel[] {
    const byRef = new Map<string, DiscoveredModel>();
    for (const ref of this.staticRefs(providerId)) {
      byRef.set(ref, this.entry(ref, ref.slice(providerId.length + 1), 'static', true));
    }
    for (const id of dynamicIds) {
      const ref = `${providerId}:${id}`;
      byRef.set(ref, this.entry(ref, id, 'dynamic', this.meta.has(ref)));
    }
    return [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  }

  /**
   * Build a discovery entry, surfacing the resolved `ModelMeta` fields only when
   * metadata is known. `FALLBACK_META` is a guess, so an unknown model leaves all
   * meta fields undefined rather than reporting a fabricated window/price.
   */
  private entry(ref: string, id: string, source: 'dynamic' | 'static', hasMeta: boolean): DiscoveredModel {
    const m = hasMeta ? this.meta.get(ref) : undefined;
    return {
      ref,
      id,
      hasMeta,
      source,
      contextWindow: m?.contextWindow,
      maxOutputTokens: m?.maxOutputTokens,
      price: m?.price,
      capabilities: m?.capabilities,
    };
  }

  private readCache(providerId: string): CacheFile | undefined {
    const c = readJson<CacheFile>(this.cacheFileFor(providerId));
    return c && c.providerId === providerId && Array.isArray(c.ids) ? c : undefined;
  }

  private async fetchIds(
    url: string,
    disc: KindDiscovery,
    key: string | undefined,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<string[]> {
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (key) {
      if (disc.auth === 'bearer') headers.Authorization = `Bearer ${key}`;
      else if (disc.auth === 'google') headers['x-goog-api-key'] = key;
    }
    const res = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return disc.parse(await res.json());
  }
}
