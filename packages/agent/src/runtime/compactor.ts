/**
 * Context compaction (agent §5.5). Summarizes the active path "base → cut" into
 * one `summary` entry (a new compaction checkpoint). Replays from the nearest
 * summary ancestor. Threshold is decided from the provider's real
 * `inputTokens` (no local estimation); overflow is the fallback.
 */
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { CompactionReason, ModelMeta } from '@enterprise-agent/agent-contract';

const SUMMARY_SYSTEM = `You compress a conversation to preserve continuity. Produce a dense summary that retains: the task goal, key decisions and findings, files/commands touched, and especially any UNFINISHED todos. Omit chit-chat. This summary replaces older turns as the new baseline.`;

/** Keep the last N messages verbatim after the summary (the "recent tail"). */
export const RECENT_TAIL = 6;

export interface CompactionResult {
  summaryText: string;
  /** Messages to send to the model: [system, summary, ...recent tail]. */
  newMessages: ModelMessage[];
  tokensBefore: number;
  tokensAfter: number;
  /** Raw provider usage of the summarization call, so the caller can account
   *  for it (agent §2.7). Undefined when the model reported none. */
  usage?: unknown;
}

export class Compactor {
  constructor(private readonly model: LanguageModel) {}

  /**
   * Summarize the in-flight messages. `tokensBefore` is the provider-reported
   * input token count at trigger time (passed in, agent §5.5 — no estimation).
   */
  async summarize(
    messages: ModelMessage[],
    _meta: ModelMeta,
    tokensBefore: number,
  ): Promise<CompactionResult> {
    const system = messages[0];
    // Partition at a single cut so the recent tail and the summarized head never
    // overlap. When the history is shorter than the tail size we still summarize
    // at least the first message (the tail then holds the remainder) — without
    // the old `slice(-RECENT_TAIL)`, which double-counted the head into both.
    const cut = Math.max(1, messages.length - RECENT_TAIL);
    const toSummarize = messages.slice(0, cut);
    const tail = messages.slice(cut);

    const { text, usage } = await generateText({
      model: this.model,
      system: SUMMARY_SYSTEM,
      prompt:
        'Summarize the following conversation for continuity:\n\n' +
        toSummarize.map(renderMessage).join('\n'),
    });

    const summaryMsg: ModelMessage = {
      role: 'user',
      content: `[Compacted context summary]\n${text}`,
    };
    const newMessages: ModelMessage[] = [];
    if (system && system.role === 'system') newMessages.push(system);
    newMessages.push(summaryMsg, ...tail);

    // Rough post-compaction size; exact value is set on next provider report.
    const tokensAfter = Math.round(text.length / 4);
    return { summaryText: text, newMessages, tokensBefore, tokensAfter, usage };
  }
}

function renderMessage(m: ModelMessage): string {
  const content =
    typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content).slice(0, 4000);
  return `${m.role}: ${content}`;
}

/**
 * Whether the provider-reported input usage crosses the compaction threshold.
 *
 * The trigger is a ratio of the *usable input budget*, not the full context
 * window: the orchestrator reserves `maxOutputTokens` of the window for its
 * reply, so the provider overflows once `inputTokens + maxOutputTokens` exceeds
 * the window — i.e. the effective input ceiling is `contextWindow −
 * maxOutputTokens`. Comparing against the full window let the proactive
 * threshold sit *above* that ceiling for models with a large output
 * reservation (e.g. 64k of 200k), so overflow fired before threshold ever did,
 * inverting the "threshold proactive, overflow safety-net" design (agent §5.5).
 */
export function crossesThreshold(
  inputTokens: number,
  meta: ModelMeta,
  compactRatio: number,
): boolean {
  const reserve = meta.maxOutputTokens > 0 && meta.maxOutputTokens < meta.contextWindow
    ? meta.maxOutputTokens
    : 0;
  const usableBudget = meta.contextWindow - reserve;
  return inputTokens >= usableBudget * compactRatio;
}

export type { CompactionReason };
