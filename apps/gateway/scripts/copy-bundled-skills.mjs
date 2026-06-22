#!/usr/bin/env node
/**
 * Build step: copy the repo-root `skills/` (vendored Agent Skills) into the
 * gateway package's `dist/skills/` so they ship with the packaged gateway
 * (`files: ["dist", "src"]`) and the Web panel can install them at runtime
 * (see web/bundled-skills.ts). No-op when the source is absent.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // apps/gateway/scripts
const src = join(here, '..', '..', '..', 'skills'); // repo-root/skills
const dest = join(here, '..', 'dist', 'skills'); // apps/gateway/dist/skills

if (!existsSync(src)) {
  console.log(`[copy-bundled-skills] no skills/ at ${src} — skipping`);
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-bundled-skills] ${src} → ${dest}`);
