/**
 * The gateway's own package version, for the PID record (desktop-app §4.5) and
 * `--version`. Resolution order:
 *   1. `EA_GATEWAY_VERSION` — set by bundlers (the desktop sidecar bundle has no
 *      adjacent package.json; esbuild `define`s this) or tests.
 *   2. The package.json next to this module's package root — works for both the
 *      tsc layout (`dist/version.js` → `../package.json`) and the source tree
 *      (`src/version.ts` → `../package.json`).
 * Undefined when neither is available; callers must treat it as optional.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function gatewayVersion(): string | undefined {
  const env = process.env.EA_GATEWAY_VERSION?.trim();
  if (env) return env;
  try {
    const file = join(HERE, '..', 'package.json');
    if (!existsSync(file)) return undefined;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
    // Guard against picking up a stranger's package.json in odd layouts.
    return pkg.name === '@dami-sg/gateway' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}
