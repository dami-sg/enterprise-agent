#!/usr/bin/env bun
/**
 * `ea` entry point (cli §3), run under **Bun** (Phase 5b). Parses argv and
 * dispatches to the Commander program; the default command launches the OpenTUI
 * TUI (cli §4), whose Solid `.tsx` needs the `@opentui/solid` Bun transform
 * plugin — registered here, before the TUI is ever (dynamically) imported.
 *
 * The plugin is registered via a non-literal specifier so the Node `tsc`
 * typecheck doesn't resolve the Solid / `bun` module graph (it pulls in
 * `import "bun"`, which has no types in the Node program). The OpenTUI screen is
 * type-checked separately by `tsconfig.tui.json`.
 */
import { buildProgram } from './commands/program.js';
import { ErrorLog, createPaths } from '@enterprise-agent/agent';

// `@opentui/solid/preload` calls `ensureSolidTransformPlugin()` (a `Bun.plugin`
// that transpiles `.tsx` with the Solid preset). Equivalent to the dev flag
// `bun --preload @opentui/solid/preload`, but self-contained so the installed
// `ea` bin doesn't depend on a cwd `bunfig.toml`.
const SOLID_PRELOAD = '@opentui/solid/preload';

async function main(): Promise<void> {
  await import(SOLID_PRELOAD); // register the transform before any .tsx loads
  await buildProgram().parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const e = err as Error;
  // Persist the fatal so a crashed `ea` invocation is retraceable (observability
  // §2/§3). Uses the default app-data root — argv parsing may have failed before
  // --root was resolved; best-effort, never let logging mask the original error.
  try {
    new ErrorLog(createPaths().errorsLog).record({
      source: 'process',
      message: `ea: ${e?.message ?? String(err)}`,
      stack: e?.stack,
    });
  } catch {
    /* ignore */
  }
  process.stderr.write(`ea: ${e?.message ?? String(err)}\n`);
  process.exit(1);
});
