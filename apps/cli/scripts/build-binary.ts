/**
 * Build standalone `ea` executables with Bun's compiler.
 *
 * The OpenTUI/Solid JSX transform is a Bun *plugin*, and plugins are only
 * available through the `Bun.build()` API — NOT the `bun build --compile` CLI —
 * so packaging the TUI into a single-file binary has to go through this script
 * (the `@opentui/solid` bun-plugin transforms the `.tsx` at build time, which is
 * why the compiled binary needs no runtime preload).
 *
 * Usage:  bun scripts/build-binary.ts [target ...]
 *   no args → host target only (tested locally)
 *   targets → any of bun-darwin-arm64 | bun-darwin-x64 | bun-linux-x64 | bun-linux-arm64 | bun-windows-x64
 *
 * Cross-compiling needs the TARGET platform's OpenTUI native package (e.g.
 * `@opentui/core-linux-x64`) present in node_modules — pnpm only installs the
 * host's variant, so cross-target builds belong on a per-platform CI runner.
 * A target whose native dep is missing fails on its own without aborting the rest.
 */
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import solidPlugin from "@opentui/solid/bun-plugin"

const here = dirname(fileURLToPath(import.meta.url))
const cliRoot = join(here, "..")
const outDir = join(cliRoot, "dist-bin")

const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [hostTarget]

mkdirSync(outDir, { recursive: true })

let failed = false
for (const target of targets) {
  const suffix = target.replace(/^bun-/, "") + (target.includes("windows") ? ".exe" : "")
  const outfile = join(outDir, `ea-${suffix}`)
  process.stdout.write(`building ${target} → ${outfile}\n`)
  try {
    const result = await Bun.build({
      entrypoints: [join(cliRoot, "src/tui-otui/compile-entry.tsx")],
      // @ts-expect-error — `compile` is a Bun.build runtime option not yet in the
      // ambient @types/bun used by the Node tsconfig; this script runs under Bun.
      compile: { target, outfile },
      plugins: [solidPlugin],
    })
    if (!result.success) {
      failed = true
      process.stderr.write(`✗ ${target}\n`)
      for (const log of result.logs) process.stderr.write(`${log}\n`)
    } else {
      process.stdout.write(`✓ ${target}\n`)
    }
  } catch (err) {
    // A missing target native dep (cross-compile) throws; isolate it so the
    // remaining targets still build.
    failed = true
    process.stderr.write(`✗ ${target}: ${(err as Error).message}\n`)
  }
}

if (failed) process.exit(1)
