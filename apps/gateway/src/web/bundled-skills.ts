/**
 * Built-in (vendored) skills shipped with the gateway (gateway §7). The repo-root
 * `skills/` is copied into `dist/skills/` at build (scripts/copy-bundled-skills.mjs)
 * so the packaged gateway can list and install them from the Web panel without the
 * source tree. Discovery mirrors the agent loader: a folder with a `SKILL.md`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundledSkill {
  /** Folder name (its identity for install). */
  dir: string;
  name: string;
  description: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled skills directory. `EA_BUNDLED_SKILLS_DIR` wins (tests / odd
 * layouts); otherwise try `dist/skills` (packaged: this module is `dist/web/…`)
 * then the repo-root `skills/` (dev: this module is `src/web/…`). Undefined when
 * none exists.
 */
export function resolveBundledSkillsDir(): string | undefined {
  const candidates = [
    process.env.EA_BUNDLED_SKILLS_DIR,
    join(HERE, '..', 'skills'), // dist/web → dist/skills (packaged)
    join(HERE, '..', '..', '..', '..', 'skills'), // src/web → repo-root/skills (dev)
  ];
  for (const c of candidates) {
    if (c && existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return undefined;
}

/** List bundled skills (folders with a `SKILL.md`), sorted by name. */
export function listBundledSkills(dir: string | undefined): BundledSkill[] {
  if (!dir || !existsSync(dir)) return [];
  const out: BundledSkill[] = [];
  for (const entry of readdirSync(dir)) {
    const md = join(dir, entry, 'SKILL.md');
    if (!existsSync(md)) continue;
    const fm = parseFrontmatter(readFileSync(md, 'utf8'));
    out.push({ dir: entry, name: fm.name || entry, description: fm.description || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal frontmatter read (mirrors the agent skill loader: `key: value`). */
function parseFrontmatter(raw: string): Record<string, string> {
  if (!raw.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const fm: Record<string, string> = {};
  for (const line of raw.slice(3, end).trim().split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) fm[m[1]!] = m[2]!.trim().replace(/^['"]|['"]$/g, '');
  }
  return fm;
}
