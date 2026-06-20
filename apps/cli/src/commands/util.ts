/**
 * Shared helpers for the headless command surface (cli §3): a lazy host
 * bootstrap wrapper and a column formatter for the `ls`-style views (§9).
 */
import { bootstrap, type BootstrapOptions, type CliContext } from '../host/bootstrap.js';
import { displayWidth, padEnd } from '../core/width.js';

export interface GlobalOpts {
  root?: string;
}

/** Construct the host, run `fn`, and always dispose (cli §2.2). */
export async function withCtx<T>(
  global: GlobalOpts,
  fn: (ctx: CliContext) => Promise<T>,
): Promise<T> {
  const opts: BootstrapOptions = { root: global.root };
  const ctx = bootstrap(opts);
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/** Render rows as a left-aligned padded table with a header (§9 ls views). */
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]): string => cells.map((c, i) => padEnd(c, widths[i]!)).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function print(s: string): void {
  process.stdout.write(s + '\n');
}

export function printErr(s: string): void {
  process.stderr.write(s + '\n');
}
