/**
 * Built-in (vendored) agent definitions shipped with the gateway (declarative
 * sub-agents, agent §2.3). The repo-root `agents/` is copied into `dist/agents/`
 * at build (scripts/copy-bundled-agents.mjs) so the packaged gateway can list and
 * install them from the Web panel without the source tree. Discovery mirrors the
 * agent loader: a folder with an `AGENT.md`. Mirrors bundled-skills.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BundledAgent {
  /** Folder name (its identity for install). */
  dir: string;
  name: string;
  description: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the bundled agents directory. `EA_BUNDLED_AGENTS_DIR` wins (tests / odd
 * layouts); otherwise try `dist/agents` (packaged: this module is `dist/web/…`)
 * then the repo-root `agents/` (dev: this module is `src/web/…`). Undefined when
 * none exists.
 */
export function resolveBundledAgentsDir(): string | undefined {
  const candidates = [
    process.env.EA_BUNDLED_AGENTS_DIR,
    join(HERE, 'agents'), // single-file bundle → sibling agents/ (desktop-app §8.1)
    join(HERE, '..', 'agents'), // dist/web → dist/agents (packaged)
    join(HERE, '..', '..', '..', '..', 'agents'), // src/web → repo-root/agents (dev)
  ];
  for (const c of candidates) {
    if (c && existsSync(c) && statSync(c).isDirectory()) return c;
  }
  return undefined;
}

/** List bundled agents (folders with an `AGENT.md`), sorted by name. */
export function listBundledAgents(dir: string | undefined): BundledAgent[] {
  if (!dir || !existsSync(dir)) return [];
  const out: BundledAgent[] = [];
  for (const entry of readdirSync(dir)) {
    const md = join(dir, entry, 'AGENT.md');
    if (!existsSync(md)) continue;
    const fm = parseFrontmatter(readFileSync(md, 'utf8'));
    out.push({ dir: entry, name: fm.name || entry, description: fm.description || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Minimal frontmatter read (mirrors the agent loader: `key: value`). */
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
