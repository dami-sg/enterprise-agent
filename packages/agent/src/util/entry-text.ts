/**
 * Single source of truth for an entry's "replay text" (agent §2.2 / §5.6).
 *
 * Concatenates only the `text` content parts — never reasoning or tool parts:
 * feeding a turn's thinking back as content bloats context and, with models that
 * leak `<think>`-style tags, confuses the next turn's tool-calling. Shared by the
 * message builder (runtime/session.ts), the classifier transcript
 * (runtime/auto-classifier.ts), and titling (index.ts) so every consumer derives
 * entry text identically.
 */
import type { Entry } from '@enterprise-agent/agent-contract';

export function entryText(entry: Pick<Entry, 'content'>): string {
  if (!entry.content) return '';
  return entry.content
    .filter((p) => {
      const t = (p as { type?: unknown }).type;
      return t === undefined || t === 'text';
    })
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('');
}
