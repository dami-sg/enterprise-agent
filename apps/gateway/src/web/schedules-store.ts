/**
 * Schedules filesystem store (§7 定时编排). A schedule is a folder under the
 * global schedules dir with a `SCHEDULE.md` (frontmatter: cron/every + targeting
 * + delivery; body: the goal prompt). This wraps the dir for the Web panel: list,
 * read (for editing), save a single-file schedule, enable/disable, and delete.
 * Enable/disable renames `SCHEDULE.md` so the runtime registry skips it — a true
 * toggle that keeps the folder in place. Mirrors agents-store.ts.
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
import { join } from 'node:path';

export interface ScheduleSummary {
  dir: string;
  name: string;
  description: string;
  /** Cron / every spec (for the listing), if any. */
  cron: string;
  enabled: boolean;
}

const SAFE_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DISABLED = 'SCHEDULE.md.disabled';

export class SchedulesStore {
  constructor(private readonly schedulesDir: string) {}

  list(): ScheduleSummary[] {
    if (!existsSync(this.schedulesDir)) return [];
    const out: ScheduleSummary[] = [];
    for (const entry of readdirSync(this.schedulesDir)) {
      const md = this.mdPath(entry);
      if (!md) continue;
      const fm = parseFrontmatter(readFileSync(md.path, 'utf8'));
      out.push({
        dir: entry,
        name: typeof fm.name === 'string' ? fm.name : entry,
        description: typeof fm.description === 'string' ? fm.description : '',
        cron: typeof fm.cron === 'string' ? fm.cron : typeof fm.every === 'string' ? `every ${fm.every}` : '',
        enabled: md.enabled,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  read(dir: string): string {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`schedule 不存在：${dir}`);
    return readFileSync(md.path, 'utf8');
  }

  setEnabled(dir: string, enabled: boolean): void {
    this.assertDir(dir);
    const md = this.mdPath(dir);
    if (!md) throw new Error(`schedule 不存在：${dir}`);
    if (md.enabled === enabled) return;
    const on = join(this.schedulesDir, dir, 'SCHEDULE.md');
    const off = join(this.schedulesDir, dir, DISABLED);
    renameSync(enabled ? off : on, enabled ? on : off);
  }

  private mdPath(dir: string): { path: string; enabled: boolean } | undefined {
    const on = join(this.schedulesDir, dir, 'SCHEDULE.md');
    if (existsSync(on)) return { path: on, enabled: true };
    const off = join(this.schedulesDir, dir, DISABLED);
    if (existsSync(off)) return { path: off, enabled: false };
    return undefined;
  }

  saveFile(content: string, dir?: string): ScheduleSummary {
    const fm = parseFrontmatter(content);
    if (typeof fm.name !== 'string' || !fm.name.trim()) throw new Error('SCHEDULE.md 缺少 frontmatter name');
    if (typeof fm.description !== 'string' || !fm.description.trim()) {
      throw new Error('SCHEDULE.md 缺少 frontmatter description');
    }
    const folder = (dir ?? slug(fm.name)).trim();
    this.assertDir(folder);
    const target = join(this.schedulesDir, folder);
    mkdirSync(target, { recursive: true });
    const cur = this.mdPath(folder);
    const enabled = cur ? cur.enabled : true;
    const file = enabled ? 'SCHEDULE.md' : DISABLED;
    writeFileSync(join(target, file), content.endsWith('\n') ? content : content + '\n');
    return {
      dir: folder,
      name: fm.name,
      description: fm.description,
      cron: typeof fm.cron === 'string' ? fm.cron : typeof fm.every === 'string' ? `every ${fm.every}` : '',
      enabled,
    };
  }

  remove(dir: string): boolean {
    this.assertDir(dir);
    const target = join(this.schedulesDir, dir);
    if (!existsSync(target)) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  }

  private assertDir(dir: string): void {
    if (!SAFE_DIR.test(dir) || dir.includes('..')) throw new Error(`非法 schedule 目录名：${dir}`);
  }
}

function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'schedule';
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
