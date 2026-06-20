/**
 * Skills loader (agent §3.6): Agent Skills standard (directory + SKILL.md).
 * Progressive disclosure — only descriptions are injected into the system
 * prompt; the full body is loaded on demand as extra instructions.
 * Discovery merges global `~/.enterprise-agent/skills/` with Workspace skills (override).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listDirs } from '../util/fs.js';

export interface SkillMeta {
  name: string;
  description: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  /** Absolute path to the SKILL.md body. */
  path: string;
  /** Directory containing the skill (scripts/, references/, assets/). */
  dir: string;
}

export interface LoadedSkill extends SkillMeta {
  body: string;
}

/** Parse a minimal YAML frontmatter block (the subset SKILL.md uses). */
export function parseFrontmatter(raw: string): { fm: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: raw };
  const block = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, '');
  const fm: Record<string, unknown> = {};
  for (const line of block.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    let value: unknown = m[2]!.trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\[.*\]$/.test(value as string)) {
      value = (value as string)
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      value = (value as string).replace(/^['"]|['"]$/g, '');
    }
    fm[key] = value;
  }
  return { fm, body };
}

function readSkill(dir: string): SkillMeta | undefined {
  const path = join(dir, 'SKILL.md');
  if (!existsSync(path)) return undefined;
  const { fm } = parseFrontmatter(readFileSync(path, 'utf8'));
  if (typeof fm.name !== 'string' || typeof fm.description !== 'string') return undefined;
  return {
    name: fm.name,
    description: fm.description,
    allowedTools: Array.isArray(fm['allowed-tools']) ? (fm['allowed-tools'] as string[]) : undefined,
    disableModelInvocation: fm['disable-model-invocation'] === true,
    path,
    dir,
  };
}

export class SkillRegistry {
  private skills = new Map<string, SkillMeta>();

  /** Discover skills, global first then workspace (workspace overrides). */
  constructor(skillRoots: string[]) {
    for (const root of skillRoots) {
      for (const name of listDirs(root)) {
        const meta = readSkill(join(root, name));
        if (meta) this.skills.set(meta.name, meta); // later roots override
      }
    }
  }

  list(): SkillMeta[] {
    return [...this.skills.values()];
  }

  /**
   * The "available skills" catalog injected into the system prompt (§3.6).
   * With `allowedToolNames`, only skills whose declared `allowed-tools` all fall
   * within that set are listed — so a sub-agent (§2.3) is offered just the skills
   * it can actually carry out with its role tool set, never one that needs a tool
   * its role hard-gate withholds (§3.4). Omit the arg for the orchestrator (which
   * holds every local tool) to get the full catalog.
   */
  catalog(allowedToolNames?: string[]): string {
    const carryable = (s: SkillMeta): boolean =>
      !allowedToolNames || !s.allowedTools || s.allowedTools.every((t) => allowedToolNames.includes(t));
    const lines = this.list()
      .filter((s) => !s.disableModelInvocation && carryable(s))
      .map((s) => `- ${s.name}: ${s.description}`);
    return lines.length ? `Available skills (load with /skill:<name> when relevant):\n${lines.join('\n')}` : '';
  }

  /** Load a skill's full body as extra instructions (progressive disclosure). */
  load(name: string): LoadedSkill | undefined {
    const meta = this.skills.get(name);
    if (!meta) return undefined;
    return { ...meta, body: readFileSync(meta.path, 'utf8') };
  }
}
