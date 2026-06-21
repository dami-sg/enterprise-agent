/**
 * Markdown → platform-text transforms (gateway §5). core emits Markdown; each
 * platform declares its own transform via `ChannelAdapter.format`. WeChat has no
 * rich text at all, so `toPlainish` strips the markup to lightly-laid-out plain
 * text (§8); `identity` is the no-op transform a passthrough channel can reuse.
 */

export function identity(text: string): string {
  return text;
}

/** Strip common Markdown to readable plain text for WeChat (gateway §5/§8). */
export function toPlainish(md: string): string {
  return md
    .replace(/```[\w-]*\n?/g, '') // code fence markers
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2') // italic
    .replace(/__([^_]+)__/g, '$1') // bold (underscore)
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '· ') // bullets
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）') // links → text（url）
    .trim();
}
