/**
 * Long-text splitting for chat platforms (gateway §5). core emits Markdown; a
 * platform caps message length (Telegram 4096 / WeChat 4000, §8). Split at the
 * most natural boundary that fits — paragraph, then line, then word, then a hard
 * cut — and never break inside a fenced code block (carry the fence across the
 * split so each chunk stays valid Markdown).
 */

/** Split `text` into chunks each ≤ `max` chars, preferring natural boundaries. */
export function splitForLimit(text: string, max: number): string[] {
  if (max <= 0) return [text];
  if (text.length <= max) return text.length ? [text] : [];

  const chunks: string[] = [];
  let rest = text;
  /** An open code fence (e.g. "```ts") to reopen on the next chunk, if any. */
  let openFence = '';

  while (rest.length > 0) {
    const budget = max - (openFence ? openFence.length + 1 : 0);
    if (rest.length <= budget) {
      chunks.push(openFence ? `${openFence}\n${rest}` : rest);
      break;
    }
    let cut = bestCut(rest, budget);
    let head = rest.slice(0, cut);
    if (openFence) head = `${openFence}\n${head}`;

    // Track fences so a chunk that opened a code block closes it, and the next
    // chunk reopens with the same fence info.
    const fence = danglingFence(head);
    if (fence !== null) {
      head = `${head}\n\`\`\``;
      openFence = fence;
    } else {
      openFence = '';
    }
    chunks.push(head);
    rest = rest.slice(cut).replace(/^\n+/, '');
    cut = 0;
  }
  return chunks;
}

/** Pick the largest break ≤ budget: paragraph > line > space > hard cut. */
function bestCut(s: string, budget: number): number {
  const window = s.slice(0, budget);
  const para = window.lastIndexOf('\n\n');
  if (para >= budget * 0.5) return para;
  const line = window.lastIndexOf('\n');
  if (line >= budget * 0.5) return line;
  const space = window.lastIndexOf(' ');
  if (space >= budget * 0.5) return space;
  return budget; // no good boundary — hard cut
}

/**
 * If `text` has an odd number of ``` fences, the last one is still open. Return
 * the opening fence line (e.g. "```ts") so the next chunk can reopen it; else null.
 */
function danglingFence(text: string): string | null {
  const lines = text.split('\n');
  let open: string | null = null;
  for (const line of lines) {
    if (line.startsWith('```')) {
      open = open === null ? line.trimEnd() : null;
    }
  }
  return open;
}
