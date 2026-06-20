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
   * Sky blue (天蓝色) — shell-escape ("!cmd") command-input mode (input border +
   * echoed command) and plan mode (the plan bar + plan-mode indicator). Truecolor
   * terminals get the exact tone; others fall back to the nearest ANSI blue.
   */
  info: '#87ceeb',
  /**
   * Reasoning / "thinking" text (§3). A deeper, clearly legible gray — the
   * earlier dim-gray styling rendered too faint to read. Truecolor terminals get
   * the exact tone; others fall back to the nearest ANSI gray.
   */
  thinking: '#9a9aa5',
  /** Soft panel background for the TopBar / sidebar chrome (§1.1). */
  panel: '#2e2e3a',
  /**
   * Background tint for the contained sub-agent log viewport (§3.1) — a slightly
   * cooler/darker tone than `panel` so a running sub-agent's bordered box reads
   * as a distinct, self-scrolling region rather than part of the main transcript.
   */
  subAgent: '#1f2630',
} as const;

export type Role = keyof typeof theme;
