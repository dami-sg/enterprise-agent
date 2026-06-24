/**
 * Agents filesystem store (declarative sub-agents, agent §2.3). Agents are folders
 * under the global agents dir, each with an `AGENT.md` (frontmatter + body); the
 * runtime discovers them by directory. This wraps the dir for the Web panel: list,
 * read (for editing), save a single-file agent, unpack an uploaded zip bundle,
 * enable/disable, install a bundled one, and delete. Folder names are validated to
 * stay inside the agents dir. Mirrors skills-store.ts — enable/disable renames
 * `AGENT.md` (the loader keys on that exact filename), a true runtime toggle that
 * keeps the folder + assets in place.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { unzip } from '../runtime/unzip.js';

export interface AgentSummary {
  /** On-disk folder name — the agent's identity for edit/delete/enable. */
  dir: string;
  name: string;
  description: string;
  /** Whether the runtime discovers it: enabled = `AGENT.md`, disabled = renamed. */
  enabled: boolean;
}

const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISABLED = 'AGENT.md.disabled';

export class AgentsStore {
  constructor(private readonly agentsDir: string) {}

  list(): AgentSummary[] {
    if (!existsSync(this.agentsDir)) return [];
    const out: AgentSummary[] = [];
    for (const entry of readdirSync(this.agentsDir)) {
      const md = this.mdPath(entry);
      if (!md) continue;
      const fm = parseFrontmatter(readFileSync(md.path, 'utf8'));
      out.push({
        dir: entry,
        name: typeof fm.name === 'string' ? fm.name : entry,
        description: typeof fm.description === 'string' ? fm.description : '',
        enabled: md.enabled,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The raw AGENT.md of an existing agent (for the editor; works when disabled). */
  read(dir: string): string {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`agent 不存在：${dir}`);
    return readFileSync(md.path, 'utf8');
  }

  /** Enable / disable an agent by renaming its AGENT.md (runtime discovery hinges
   *  on that exact filename), keeping the folder and assets untouched. */
  setEnabled(dir: string, enabled: boolean): void {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`agent 不存在：${dir}`);
    if (md.enabled === enabled) return;
    const on = join(this.agentsDir, dir, 'AGENT.md');
    const off = join(this.agentsDir, dir, DISABLED);
    renameSync(enabled ? off : on, enabled ? on : off);
  }

  /** Locate an agent's markdown (enabled `AGENT.md` or the disabled rename). */
  private mdPath(dir: string): { path: string; enabled: boolean } | undefined {
    const on = join(this.agentsDir, dir, 'AGENT.md');
    if (existsSync(on)) return { path: on, enabled: true };
    const off = join(this.agentsDir, dir, DISABLED);
    if (existsSync(off)) return { path: off, enabled: false };
    return undefined;
  }

  /**
   * Create or overwrite a single-file agent's AGENT.md. On add, the folder is
   * derived from the frontmatter `name`; on edit, the caller passes the existing
   * folder so a name change doesn't orphan the directory.
   */
  saveFile(content: string, dir?: string): AgentSummary {
    const fm = parseFrontmatter(content);
    if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('AGENT.md 缺少 frontmatter name');
    if (typeof fm.description !== 'string' || !fm.description.trim()) {
      throw new Error('AGENT.md 缺少 frontmatter description');
    }
    const folder = (dir ?? slug(fm.name)).trim();
    this.assertDir(folder);
    const target = join(this.agentsDir, folder);
    mkdirSync(target, { recursive: true });
    // Editing a currently-disabled agent keeps it disabled (write the renamed file).
    const cur = this.mdPath(folder);
    const enabled = cur ? cur.enabled : true;
    const file = enabled ? 'AGENT.md' : DISABLED;
    writeFileSync(join(target, file), content.endsWith('\n') ? content : content + '\n');
    return { dir: folder, name: fm.name, description: fm.description, enabled };
  }

  /** Unpack an agent zip (a folder with AGENT.md, or AGENT.md + assets at root). */
  addZip(buf: Buffer): AgentSummary {
    const entries = unzip(buf);
    const agent = entries.find((e) => e.path === 'AGENT.md' || e.path.endsWith('/AGENT.md'));
    if (!agent) throw new Error('zip 中找不到 AGENT.md');
    const fm = parseFrontmatter(agent.data.toString('utf8'));
    if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('AGENT.md 缺少 frontmatter name');
    const folder = slug(fm.name);
    this.assertDir(folder);
    const prefix = agent.path.slice(0, agent.path.length - 'AGENT.md'.length); // '' or 'pkg/'
    const target = join(this.agentsDir, folder);
    rmSync(target, { recursive: true, force: true }); // replace wholesale on re-upload
    for (const e of entries) {
      if (prefix && !e.path.startsWith(prefix)) continue;
      const rel = e.path.slice(prefix.length);
      if (!rel) continue;
      const dest = join(target, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.data);
    }
    return { dir: folder, name: fm.name, description: typeof fm.description === 'string' ? fm.description : '', enabled: true };
  }

  remove(dir: string): boolean {
    this.assertDir(dir);
    const target = join(this.agentsDir, dir);
    if (!existsSync(target)) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  }

  /**
   * Install an agent folder from `srcDir/<dir>` into the agents dir, replacing any
   * existing copy (used for built-in agents). Validates the folder name and that
   * the source carries an `AGENT.md`.
   */
  installFrom(srcDir: string, dir: string): AgentSummary {
    this.assertDir(dir);
    const from = join(srcDir, dir);
    const md = join(from, 'AGENT.md');
    if (!existsSync(md)) throw new Error(`内置 agent 不存在：${dir}`);
    const fm = parseFrontmatter(readFileSync(md, 'utf8'));
    const target = join(this.agentsDir, dir);
    mkdirSync(this.agentsDir, { recursive: true });
    rmSync(target, { recursive: true, force: true }); // replace wholesale
    cpSync(from, target, { recursive: true });
    return {
      dir,
      name: typeof fm.name === 'string' ? fm.name : dir,
      description: typeof fm.description === 'string' ? fm.description : '',
      enabled: true,
    };
  }

  private assertDir(dir: string): void {
    if (!SAFE_DIR.test(dir) || dir.includes('..')) throw new Error(`非法 agent 目录名：${dir}`);
  }
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agent';
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
