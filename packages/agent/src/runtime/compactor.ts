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
    const tail = messages.slice(-RECENT_TAIL);
    const toSummarize = messages.slice(0, Math.max(1, messages.length - RECENT_TAIL));

    const { text } = await generateText({
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
    return { summaryText: text, newMessages, tokensBefore, tokensAfter };
  }
}

function renderMessage(m: ModelMessage): string {
  const content =
    typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content).slice(0, 4000);
  return `${m.role}: ${content}`;
}

/** Whether the provider-reported input usage crosses the compaction threshold. */
export function crossesThreshold(
  inputTokens: number,
  meta: ModelMeta,
  compactRatio: number,
): boolean {
  return inputTokens >= meta.contextWindow * compactRatio;
}

export type { CompactionReason };
