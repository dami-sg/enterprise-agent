/**
 * Model metadata registry (agent §2.6 pt.6) — context window + pricing.
 * Prerequisite for token cost accounting (§2.7) and compaction threshold (§5.5).
 */
import type { ModelMeta, EntryUsage } from '@dami-sg/agent-contract';

/**
 * Built-in model metadata — deliberately a MINIMAL set, not a mirror of every
 * provider. Two jobs only:
 *   1. Seed the model list for providers that can't be discovered dynamically
 *      (no usable `${baseURL}/models`), since `ModelCatalog` builds its list as
 *      static refs (these keys) ∪ discovered ids. Without a built-in entry such
 *      a provider would show zero models.
 *   2. Provide context-window + pricing for those same refs so cost accounting
 *      (§2.7) and the compaction gauge (§5.5) work before/without models.dev.
 *
 * Everything discoverable (openai, deepseek, openrouter, local servers, …) is
 * intentionally absent: its list comes from `${baseURL}/models` and its meta
 * from the models.dev catalog (models-dev.ts) → `FALLBACK_META`. So the only
 * entries that belong here are providers whose discovery is missing or unreliable:
 *   - anthropic  — no `/models` endpoint at all (model list must be built-in)
 *   - minimax    — `/models` may return an incomplete list (seed the flagship)
 */
export const BUILTIN_MODEL_META: Record<string, ModelMeta> = {
  'anthropic:claude-sonnet-4.5': {
    ref: 'anthropic:claude-sonnet-4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    price: { input: 3, output: 15, cachedInput: 0.3 },
    capabilities: ['text', 'tool_call', 'structured_output', 'image', 'pdf', 'reasoning'],
  },
  'anthropic:claude-opus-4.1': {
    ref: 'anthropic:claude-opus-4.1',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    price: { input: 15, output: 75, cachedInput: 1.5 },
    capabilities: ['text', 'tool_call', 'structured_output', 'image', 'pdf', 'reasoning'],
  },
  'anthropic:claude-haiku-4.5': {
    ref: 'anthropic:claude-haiku-4.5',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    price: { input: 1, output: 5, cachedInput: 0.1 },
    capabilities: ['text', 'tool_call', 'structured_output', 'image', 'pdf'],
  },
  // MiniMax — OpenAI-compatible; `/models` may return an incomplete list, so the
  // flagship is seeded statically to guarantee it appears (base api.minimax.io/v1).
  'minimax:MiniMax-M2.7': {
    ref: 'minimax:MiniMax-M2.7',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ['text', 'tool_call', 'reasoning'],
  },
};

/** Conservative default when a model has no registered metadata. */
export const FALLBACK_META: ModelMeta = {
  ref: 'unknown',
  contextWindow: 128_000,
  maxOutputTokens: 8_000,
  // No price → cost recorded as 0 and flagged "no pricing" (agent §2.7).
};

export class ModelMetaRegistry {
  private readonly map = new Map<string, ModelMeta>(
    Object.entries(BUILTIN_MODEL_META),
  );
  /**
   * Optional secondary source consulted after the built-ins (agent §2.6) — wired
   * to the models.dev catalog (models-dev.ts) so discovered/custom models get a
   * real context window + pricing instead of `FALLBACK_META`.
   */
  private external?: (ref: string) => ModelMeta | undefined;

  register(meta: ModelMeta): void {
    this.map.set(meta.ref, meta);
  }

  /** Attach an external metadata resolver (e.g. the models.dev catalog). */
  setExternalResolver(resolver: (ref: string) => ModelMeta | undefined): void {
    this.external = resolver;
  }

  get(ref: string): ModelMeta {
    return this.map.get(ref) ?? this.external?.(ref) ?? { ...FALLBACK_META, ref };
  }

  hasPrice(ref: string): boolean {
    return Boolean(this.resolved(ref)?.price);
  }

  /** Whether a real `ModelMeta` is known (built-in or external) vs falling back. */
  has(ref: string): boolean {
    return this.map.has(ref) || Boolean(this.external?.(ref));
  }

  private resolved(ref: string): ModelMeta | undefined {
    return this.map.get(ref) ?? this.external?.(ref);
  }

  /** All registered refs — used by model discovery to seed static models. */
  refs(): string[] {
    return [...this.map.keys()];
  }
}

/**
 * Cost in USD for a single step's usage (agent §2.7). 0 when no pricing.
 * Note: providers report `cachedInputTokens` as a SUBSET of `inputTokens`, so
 * the cached portion is billed at the (cheaper) cached price and subtracted
 * from the full-price input — billing it at both would double-charge.
 */
export function costOf(usage: EntryUsage, meta: ModelMeta): number {
  if (!meta.price) return 0;
  const { input, output, cachedInput = 0 } = meta.price;
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  return (
    (uncachedInput * input + usage.outputTokens * output + cached * cachedInput) /
    1e6
  );
}
