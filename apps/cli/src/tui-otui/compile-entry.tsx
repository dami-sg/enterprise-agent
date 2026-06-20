/**
 * Standalone-binary entry for `bun build --compile` (see scripts/build-binary.ts).
 *
 * Unlike bin.ts — which dynamically imports the Solid preload + TUI via
 * NON-LITERAL specifiers so the Node `tsc` program never resolves the Solid/.tsx
 * world — this entry STATICALLY imports the TUI launcher and injects it into
 * `buildProgram`, so Bun's bundler can include it (a non-literal dynamic import
 * can't be compiled into a standalone binary). The Solid `.tsx` is transformed
 * at build time by the `@opentui/solid` bun-plugin, so no runtime preload is
 * needed here. This file is excluded from the Node tsconfig and type-checked by
 * tsconfig.tui.json alongside the rest of `tui-otui`.
 */
import { buildProgram } from "../commands/program.js"
import { launchTui } from "./launch.js"

buildProgram({ launchTui })
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`ea: ${(err as Error).message}\n`)
    process.exit(1)
  })
