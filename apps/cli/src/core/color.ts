/**
 * Minimal ANSI colour for headless output (§1.2). Honours `NO_COLOR` and
 * non-TTY stderr so piped/`NO_COLOR` runs degrade to plain text without losing
 * information — glyphs carry the meaning, colour only reinforces it.
 */
const enabled = !process.env['NO_COLOR'] && process.stderr.isTTY;

function wrap(code: number): (s: string) => string {
  return (s: string) => (enabled ? `[${code}m${s}[0m` : s);
}

export const color = {
  enabled,
  accent: wrap(36), // cyan
  success: wrap(32), // green
  warning: wrap(33), // yellow
  danger: wrap(31), // red
  muted: wrap(90), // bright black
  bold: wrap(1),
};
