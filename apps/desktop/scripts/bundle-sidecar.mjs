#!/usr/bin/env node
/**
 * Build the gateway sidecar bundle (desktop-app §8.1): esbuild the whole
 * `ea-gateway` CLI into a single ESM file the Electron binary can run with
 * `ELECTRON_RUN_AS_NODE=1`. The gateway graph has NO native modules (SQLite is
 * the `node:sqlite` builtin), so one file + the bundled skills/agents asset
 * directories is the entire sidecar.
 *
 * Layout produced (shipped via electron-builder extraResources):
 *   resources/sidecar/gateway.mjs    # the bundle
 *   resources/sidecar/skills/        # repo-root skills/ (bundled-skills.ts sibling lookup)
 *   resources/sidecar/agents/        # repo-root agents/ (bundled-agents.ts sibling lookup)
 *   resources/sidecar/version.json   # { version } — for the §4.5 version-alignment check
 *
 * Workspace deps are resolved through their package `exports` (dist/), so run
 * `pnpm -r build` (or at least build agent-contract/agent/agent-server/cli/gateway)
 * before bundling.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..');
const repoRoot = join(desktopRoot, '..', '..');
const gatewayRoot = join(repoRoot, 'apps', 'gateway');
const outDir = join(desktopRoot, 'resources', 'sidecar');

const gatewayPkg = JSON.parse(readFileSync(join(gatewayRoot, 'package.json'), 'utf8'));
const version = gatewayPkg.version;

// The bundle imports workspace deps via their built dist/ — fail fast with a
// hint instead of a confusing resolve error mid-build.
for (const dep of ['agent-contract', 'agent', 'agent-server', 'cli']) {
  const dist = join(repoRoot, dep === 'cli' ? 'apps' : 'packages', dep, 'dist', 'index.js');
  if (!existsSync(dist)) {
    console.error(`[bundle-sidecar] 缺少 ${dep} 的 dist/ — 先在仓库根目录跑 \`pnpm -r build\``);
    process.exit(1);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(gatewayRoot, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(outDir, 'gateway.mjs'),
  // The bundle has no adjacent package.json — inject the version (version.ts).
  define: { 'process.env.EA_GATEWAY_VERSION': JSON.stringify(version) },
  // CJS deps in an ESM bundle need a real `require` (esbuild's documented shim).
  banner: {
    js: "import { createRequire as __sidecarCreateRequire } from 'node:module';\nconst require = globalThis.require ?? __sidecarCreateRequire(import.meta.url);",
  },
  // `bun:sqlite` is the dead branch under Node (accounts/db.ts); never resolve it.
  external: ['bun:sqlite'],
  sourcemap: false,
  logLevel: 'warning',
});

// Bundled skills/agents are directory assets, not code — ship them as siblings
// of the bundle (bundled-skills.ts / bundled-agents.ts check `HERE/skills` first).
for (const asset of ['skills', 'agents']) {
  const src = join(repoRoot, asset);
  if (existsSync(src)) {
    cpSync(src, join(outDir, asset), { recursive: true });
    console.log(`[bundle-sidecar] ${asset}/ → resources/sidecar/${asset}/`);
  }
}

writeFileSync(join(outDir, 'version.json'), JSON.stringify({ version }) + '\n');
console.log(`[bundle-sidecar] gateway.mjs v${version} → ${outDir}`);
