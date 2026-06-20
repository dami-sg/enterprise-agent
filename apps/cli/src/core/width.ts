/**
 * Terminal display-width helpers (§1.5). CJK / full-width code points occupy
 * two cells, so naive `.length` padding misaligns Chinese columns. Shared by
 * the headless table formatter (commands/util) and the in-TUI config/branch
 * views (§8 / §9).
 */

// Built without an embedded ESC byte so the source stays plain-ASCII.
const ANSI = new RegExp('\\x1b\\[[0-9;]*m', 'g');

/** Rough East-Asian-wide ranges — enough for CJK + common full-width glyphs. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals / punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xff00 && cp <= 0xff60) || // full-width forms
    (cp >= 0x1f300 && cp <= 0x1faff) // emoji / pictographs
  );
}

/** Display width ignoring ANSI; wide code points count as 2. */
export function displayWidth(s: string): number {
  const plain = s.replace(ANSI, '');
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

/** Right-pad to a target display width (no-op if already wider). */
export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/** Truncate to a target display width, adding an ellipsis when cut. */
export function truncateW(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}
