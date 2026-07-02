/**
 * models.dev metadata source (agent §2.6). The built-in `BUILTIN_MODEL_META`
 * only covers a handful of curated refs; every other model — anything a user
 * discovers from an OpenAI-compatible / gateway provider — would otherwise fall
 * back to `FALLBACK_META` (a guessed 128k context, no pricing). That makes the
 * context-window gauge and cost accounting (agent §2.7) wrong for most models.
 *
 * models.dev publishes a community-maintained catalog of context window, output
 * limit and pricing for ~5k models at https://models.dev/api.json. We fetch it
 * once, cache it to disk with a TTL (like the per-provider model cache), and
 * expose a synchronous `lookup(ref)` that `ModelMetaRegistry.get` consults
 * before falling back. Failures are silent: a missing/stale cache just means we
 * fall back to the built-ins, never an error.
 */
import type { ModelCapability, ModelMeta } from '@enterprise-agent/agent-contract';
import { readJson, writeJson } from '../util/fs.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matching per-provider discovery
const FETCH_TIMEOUT_MS = 8_000;

/** Loose shape of one models.dev model entry — read defensively. */
interface RawModel {
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number };
  tool_call?: boolean;
  reasoning?: boolean;
  modalities?: { input?: string[] };
}
interface RawProvider {
  models?: Record<string, RawModel>;
}
/** `{ "<providerId>": { models: { "<modelId>": {...} } } }`. */
type RawCatalog = Record<string, RawProvider>;

interface CacheFile {
  fetchedAt: number;
  catalog: RawCatalog;
}

/** Synchronous metadata lookup over a parsed models.dev catalog. */
export interface ModelsDevIndex {
  /** Meta for a `providerId:modelId` ref, or undefined if unknown. */
  lookup(ref: string): ModelMeta | undefined;
  /** Number of indexed models (0 → no usable cache yet). */
  readonly size: number;
}

/** Convert one models.dev entry into our `ModelMeta` (undefined if unusable). */
function toMeta(ref: string, m: RawModel): ModelMeta | undefined {
  const context = m.limit?.context;
  if (!context || context <= 0) return undefined; // context window is the whole point
  const caps: ModelCapability[] = [];
  if (m.tool_call) caps.push('tool_call');
  if (m.reasoning) caps.push('reasoning');
  const inputs = m.modalities?.input ?? [];
  if (inputs.includes('text')) caps.push('text');
  if (inputs.includes('image')) caps.push('image');
  if (inputs.includes('pdf')) caps.push('pdf');
  if (inputs.includes('audio')) caps.push('audio');
  if (inputs.includes('video')) caps.push('video');
  const price =
    m.cost && typeof m.cost.input === 'number'
      ? { input: m.cost.input, output: m.cost.output ?? 0, cachedInput: m.cost.cache_read }
      : undefined;
  return {
    ref,
    contextWindow: context,
    // Pre-fill a conservative output reservation when the catalog omits it, so
    // the usable-input budget (context − output) is always computable (agent §2.6).
    maxOutputTokens: m.limit?.output ?? Math.min(8_192, context),
    price,
    capabilities: caps.length ? caps : undefined,
  };
}

/** Build a lookup index from a raw catalog. Keyed by exact ref and by model id. */
export function buildModelsDevIndex(catalog: RawCatalog): ModelsDevIndex {
  const byRef = new Map<string, ModelMeta>();
  const byModel = new Map<string, ModelMeta>();
  for (const [providerId, prov] of Object.entries(catalog ?? {})) {
    for (const [modelId, raw] of Object.entries(prov?.models ?? {})) {
      const ref = `${providerId}:${modelId}`;
      const meta = toMeta(ref, raw);
      if (!meta) continue;
      byRef.set(ref, meta);
      // First provider to define a model id wins the by-id slot; the same model
      // generally has identical limits across providers, so this is safe enough.
      if (!byModel.has(modelId)) byModel.set(modelId, meta);
    }
  }
  return {
    size: byRef.size,
    lookup(ref: string): ModelMeta | undefined {
      const direct = byRef.get(ref);
      if (direct) return { ...direct, ref };
      // Provider id mismatch (e.g. a custom-named openai-compatible provider):
      // fall back to matching by the bare model id.
      const sep = ref.indexOf(':');
      if (sep < 0) return undefined;
      const modelId = ref.slice(sep + 1);
      const byId = byModel.get(modelId);
      return byId ? { ...byId, ref } : undefined;
    },
  };
}

export interface ModelsDevStoreOptions {
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Disk-cached models.dev catalog. `index()` is synchronous (reads the on-disk
 * cache, lazily, and memoizes once non-empty); `refresh()` re-fetches when the
 * cache is missing or older than the TTL. Shared by the host (accounting) and
 * the CLI (config views) via the same cache file.
 */
export class ModelsDevStore {
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: ModelsDevIndex;
  private inflight?: Promise<void>;

  constructor(
    private readonly cacheFile: string,
    opts: ModelsDevStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  }

  /** Current index from the on-disk cache. Empty (size 0) until first populated. */
  index(): ModelsDevIndex {
    // Memoize only a non-empty index, so a freshly-written cache (e.g. by the
    // host process) is still picked up by a store that booted before it existed.
    if (this.cached && this.cached.size > 0) return this.cached;
    const file = readJson<CacheFile>(this.cacheFile);
    const index = buildModelsDevIndex(file?.catalog ?? {});
    if (index.size > 0) this.cached = index;
    return index;
  }

  /** A `ModelMeta` resolver bindable to `ModelMetaRegistry.setExternalResolver`. */
  resolver(): (ref: string) => ModelMeta | undefined {
    return (ref) => this.index().lookup(ref);
  }

  private isStale(): boolean {
    const file = readJson<CacheFile>(this.cacheFile);
    return !file || this.now() - file.fetchedAt >= this.ttlMs;
  }

  /**
   * Refresh the cache from models.dev if missing/stale (or `force`). Silent on
   * any failure — the existing cache (or the built-ins) keep working.
   */
  async refresh(force = false): Promise<void> {
    if (!force && !this.isStale()) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Bound the body: this is remote data feeding cost accounting and the
        // compaction gauge. A compromised/oversized response must not exhaust
        // memory or poison the cache unbounded (agent §2.6). 32 MB is generous
        // for the model catalog (~a few MB today).
        const MAX_BYTES = 32 * 1024 * 1024;
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error('models.dev response too large');
        const catalog = JSON.parse(text) as RawCatalog;
        writeJson(this.cacheFile, { fetchedAt: this.now(), catalog } satisfies CacheFile);
        this.cached = buildModelsDevIndex(catalog);
      } catch {
        // Silent fallback (agent §2.6 pt.5): keep whatever cache/builtins exist.
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}
