/**
 * Role → colour mapping (§1.2), shared by the OpenTUI/Solid TUI. Colour is a
 * redundant reinforcement on top of glyphs, so a `NO_COLOR` / monochrome
 * terminal loses nothing essential.
 */
export const theme = {
  accent: 'cyan',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  muted: 'gray',
  /**
   * Reasoning / "thinking" text (§3). A deeper, clearly legible gray — the
   * earlier dim-gray styling rendered too faint to read. Truecolor terminals get
   * the exact tone; others fall back to the nearest ANSI gray.
   */
  thinking: '#9a9aa5',
  /** Soft panel background for the TopBar / sidebar chrome (§1.1). */
  panel: '#2e2e3a',
} as const;

export type Role = keyof typeof theme;
