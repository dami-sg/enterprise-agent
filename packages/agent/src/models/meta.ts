/**
 * Model metadata registry (agent §2.6 pt.6) — context window + pricing.
 * Prerequisite for token cost accounting (§2.7) and compaction threshold (§5.5).
 */
import type { ModelMeta, EntryUsage } from '@enterprise-agent/agent-contract';

/** Built-in metadata for common models. `openai-compatible`/local can be added. */
export const BUILTIN_MODEL_META: Record<string, ModelMeta> = {
  'anthropic:claude-sonnet-4.5': {
    ref: 'anthropic:claude-sonnet-4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    price: { input: 3, output: 15, cachedInput: 0.3 },
    capabilities: ['tools', 'structured-output', 'vision', 'reasoning'],
  },
  'anthropic:claude-opus-4.1': {
    ref: 'anthropic:claude-opus-4.1',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    price: { input: 15, output: 75, cachedInput: 1.5 },
    capabilities: ['tools', 'structured-output', 'vision', 'reasoning'],
  },
  'anthropic:claude-haiku-4.5': {
    ref: 'anthropic:claude-haiku-4.5',
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    price: { input: 1, output: 5, cachedInput: 0.1 },
    capabilities: ['tools', 'structured-output', 'vision'],
  },
  'openai:gpt-4.1': {
    ref: 'openai:gpt-4.1',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    price: { input: 2, output: 8, cachedInput: 0.5 },
    capabilities: ['tools', 'structured-output', 'vision'],
  },
  'openai:gpt-4.1-mini': {
    ref: 'openai:gpt-4.1-mini',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_000,
    price: { input: 0.4, output: 1.6, cachedInput: 0.1 },
    capabilities: ['tools', 'structured-output', 'vision'],
  },
  // DeepSeek — OpenAI-compatible (base https://api.deepseek.com)
  'deepseek:deepseek-v4-pro': {
    ref: 'deepseek:deepseek-v4-pro',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    price: { input: 1.74, output: 3.48, cachedInput: 0.145 },
    capabilities: ['tools', 'reasoning'],
  },
  'deepseek:deepseek-v4-flash': {
    ref: 'deepseek:deepseek-v4-flash',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    price: { input: 0.14, output: 0.28, cachedInput: 0.028 },
    capabilities: ['tools', 'reasoning'],
  },
  // MiniMax — OpenAI-compatible (base https://api.minimax.io/v1)
  'minimax:MiniMax-M2.7': {
    ref: 'minimax:MiniMax-M2.7',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ['tools', 'reasoning'],
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

  register(meta: ModelMeta): void {
    this.map.set(meta.ref, meta);
  }

  get(ref: string): ModelMeta {
    return this.map.get(ref) ?? { ...FALLBACK_META, ref };
  }

  hasPrice(ref: string): boolean {
    return Boolean(this.map.get(ref)?.price);
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
