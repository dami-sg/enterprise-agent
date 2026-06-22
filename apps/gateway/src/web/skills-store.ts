/**
 * Skills filesystem store (gateway §7). Skills are folders under the global
 * skills dir, each with a `SKILL.md` (YAML-ish frontmatter + body); the runtime
 * discovers them by directory. This wraps the dir for the Web panel: list,
 * read (for editing), save a single-file skill, unpack an uploaded zip bundle,
 * and delete. Folder names are validated to stay inside the skills dir.
 */
import {
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

export interface SkillSummary {
  /** On-disk folder name — the skill's identity for edit/delete/enable. */
  dir: string;
  name: string;
  description: string;
  /** Whether the runtime discovers it: enabled = `SKILL.md`, disabled = renamed. */
  enabled: boolean;
}

const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Disabling renames SKILL.md so the agent's loader (which keys on SKILL.md) skips
// the folder — a true runtime disable that keeps the folder + assets in place.
const DISABLED = 'SKILL.md.disabled';

export class SkillsStore {
  constructor(private readonly skillsDir: string) {}

  list(): SkillSummary[] {
    if (!existsSync(this.skillsDir)) return [];
    const out: SkillSummary[] = [];
    for (const entry of readdirSync(this.skillsDir)) {
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

  /** The raw SKILL.md of an existing skill (for the editor; works when disabled). */
  read(dir: string): string {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`技能不存在：${dir}`);
    return readFileSync(md.path, 'utf8');
  }

  /** Enable / disable a skill by renaming its SKILL.md (runtime discovery hinges
   *  on that exact filename), keeping the folder and assets untouched. */
  setEnabled(dir: string, enabled: boolean): void {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`技能不存在：${dir}`);
    if (md.enabled === enabled) return;
    const on = join(this.skillsDir, dir, 'SKILL.md');
    const off = join(this.skillsDir, dir, DISABLED);
    renameSync(enabled ? off : on, enabled ? on : off);
  }

  /** Locate a skill's markdown (enabled `SKILL.md` or the disabled rename). */
  private mdPath(dir: string): { path: string; enabled: boolean } | undefined {
    const on = join(this.skillsDir, dir, 'SKILL.md');
    if (existsSync(on)) return { path: on, enabled: true };
    const off = join(this.skillsDir, dir, DISABLED);
    if (existsSync(off)) return { path: off, enabled: false };
    return undefined;
  }

  /**
   * Create or overwrite a single-file skill's SKILL.md. On add, the folder is
   * derived from the frontmatter `name`; on edit, the caller passes the existing
   * folder so a name change doesn't orphan the directory.
   */
  saveFile(content: string, dir?: string): SkillSummary {
    const fm = parseFrontmatter(content);
    if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('SKILL.md 缺少 frontmatter name');
    if (typeof fm.description !== 'string' || !fm.description.trim()) {
      throw new Error('SKILL.md 缺少 frontmatter description');
    }
    const folder = (dir ?? slug(fm.name)).trim();
    this.assertDir(folder);
    const target = join(this.skillsDir, folder);
    mkdirSync(target, { recursive: true });
    // Editing a currently-disabled skill keeps it disabled (write the renamed file).
    const cur = this.mdPath(folder);
    const enabled = cur ? cur.enabled : true;
    const file = enabled ? 'SKILL.md' : DISABLED;
    writeFileSync(join(target, file), content.endsWith('\n') ? content : content + '\n');
    return { dir: folder, name: fm.name, description: fm.description, enabled };
  }

  /** Unpack a skill zip (a folder with SKILL.md, or SKILL.md + assets at root). */
  addZip(buf: Buffer): SkillSummary {
    const entries = unzip(buf);
    const skill = entries.find((e) => e.path === 'SKILL.md' || e.path.endsWith('/SKILL.md'));
    if (!skill) throw new Error('zip 中找不到 SKILL.md');
    const fm = parseFrontmatter(skill.data.toString('utf8'));
    if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('SKILL.md 缺少 frontmatter name');
    const folder = slug(fm.name);
    this.assertDir(folder);
    const prefix = skill.path.slice(0, skill.path.length - 'SKILL.md'.length); // '' or 'pkg/'
    const target = join(this.skillsDir, folder);
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
    const target = join(this.skillsDir, dir);
    if (!existsSync(target)) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  }

  private assertDir(dir: string): void {
    if (!SAFE_DIR.test(dir) || dir.includes('..')) throw new Error(`非法技能目录名：${dir}`);
  }
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'skill';
}

/** Minimal frontmatter read (mirrors the agent's skill loader: `key: value`). */
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
