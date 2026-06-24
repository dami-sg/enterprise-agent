#!/usr/bin/env node
/**
 * Build step: copy the repo-root `agents/` (vendored declarative sub-agents) into
 * the gateway package's `dist/agents/` so they ship with the packaged gateway
 * (`files: ["dist", "src"]`) and the Web panel can install them at runtime
 * (see web/bundled-agents.ts). No-op when the source is absent.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/gateway/scripts
const src = join(here, '..', '..', '..', 'agents'); // repo-root/agents
const dest = join(here, '..', 'dist', 'agents'); // apps/gateway/dist/agents

if (!existsSync(src)) {
  console.log(`[copy-bundled-agents] no agents/ at ${src} — skipping`);
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-bundled-agents] ${src} → ${dest}`);
