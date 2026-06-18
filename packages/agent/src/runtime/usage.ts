/** Normalize AI SDK v6 LanguageModelUsage into our TokenUsage (agent §2.7). */
import type { TokenUsage } from '@enterprise-agent/agent-contract';

export function toTokenUsage(u: unknown): TokenUsage {
  const usage = (u ?? {}) as Record<string, number | undefined>;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
}
