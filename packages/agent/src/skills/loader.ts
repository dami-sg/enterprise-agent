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
  /** Optional search keywords (frontmatter `keywords:`) — lift recall only. */
  keywords?: string[];
  /** Absolute path to the SKILL.md body. */
  path: string;
  /** Directory containing the skill (scripts/, references/, assets/). */
  dir: string;
}

export interface LoadedSkill extends SkillMeta {
  body: string;
}

/** One ranked search hit (loader.search). */
export interface SkillHit {
  meta: SkillMeta;
  score: number;
}

export interface SkillSearchOptions {
  /** Restrict to skills carryable by this tool set (a sub-agent's role kit). */
  allowedToolNames?: string[];
  /** Cap the number of hits returned. */
  limit?: number;
}

/**
 * Above this many model-invocable skills the injected catalog stops listing
 * every description (which would bloat the prompt) and switches to "search
 * mode": tell the model to call searchSkills, plus a small relevance-ranked
 * prefetch for the current turn. At or below it, behaviour is the legacy full
 * dump — so typical setups (a handful of skills) are unchanged.
 */
export const DEFAULT_SKILL_SEARCH_THRESHOLD = 12;

/** How many relevance-ranked skills to prefetch into the catalog in search mode. */
const SEARCH_MODE_PREFETCH = 5;

const WORD_RE = /[a-z0-9]+/g;

/** Lowercase word tokens (`[a-z0-9]+`). */
function tokenize(s: string): string[] {
  return s.toLowerCase().match(WORD_RE) ?? [];
}

/**
 * Lexical relevance of a skill to the (already-tokenized, deduped) query.
 * Weights name > keywords > description; rewards description term frequency
 * (capped) and falls back to substring hits so partial words still match.
 */
function scoreSkill(queryTokens: string[], meta: SkillMeta): number {
  if (!queryTokens.length) return 0;
  const name = meta.name.toLowerCase();
  const nameTokens = new Set(tokenize(meta.name));
  const kwTokens = new Set((meta.keywords ?? []).flatMap(tokenize));
  const desc = meta.description.toLowerCase();
  const descFreq = new Map<string, number>();
  for (const t of tokenize(meta.description)) descFreq.set(t, (descFreq.get(t) ?? 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    if (nameTokens.has(q)) score += 6;
    else if (name.includes(q)) score += 3;
    if (kwTokens.has(q)) score += 4;
    const freq = descFreq.get(q) ?? 0;
    if (freq) score += 1 + Math.min(freq, 3);
    else if (desc.includes(q)) score += 1;
  }
  return score;
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
    keywords: Array.isArray(fm.keywords)
      ? (fm.keywords as string[])
      : typeof fm.keywords === 'string'
        ? (fm.keywords as string).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    path,
    dir,
  };
}

export class SkillRegistry {
  private skills = new Map<string, SkillMeta>();
  private readonly searchThreshold: number;

  /** Discover skills, global first then workspace (workspace overrides). */
  constructor(skillRoots: string[], opts: { searchThreshold?: number } = {}) {
    this.searchThreshold = opts.searchThreshold ?? DEFAULT_SKILL_SEARCH_THRESHOLD;
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
   * The skills a model may auto-invoke given a tool set: model-invocable
   * (`disable-model-invocation` excluded) and carryable — every declared
   * `allowed-tools` falls within `allowedToolNames`. Omit `allowedToolNames`
   * (the orchestrator, which holds every local tool) for no tool filter (§3.4).
   */
  visibleList(allowedToolNames?: string[]): SkillMeta[] {
    const carryable = (s: SkillMeta): boolean =>
      !allowedToolNames || !s.allowedTools || s.allowedTools.every((t) => allowedToolNames.includes(t));
    return this.list().filter((s) => !s.disableModelInvocation && carryable(s));
  }

  /**
   * Rank visible skills by lexical relevance to `query` (§3.6 search). Hits with
   * a zero score are dropped; ties break by name for stable ordering. Empty
   * query → no hits.
   */
  search(query: string, opts: SkillSearchOptions = {}): SkillHit[] {
    // Drop single-char tokens (stopwords like "a"/"i"): they carry no signal and
    // their substring fallback would match almost every description.
    const q = [...new Set(tokenize(query))].filter((t) => t.length >= 2);
    if (!q.length) return [];
    const scored = this.visibleList(opts.allowedToolNames)
      .map((meta) => ({ meta, score: scoreSkill(q, meta) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.meta.name.localeCompare(b.meta.name));
    return opts.limit ? scored.slice(0, opts.limit) : scored;
  }

  /**
   * The "available skills" block injected into the system prompt (§3.6).
   * `allowedToolNames` filters to skills carryable by that tool set (a sub-agent
   * is never offered one needing a tool its role hard-gate withholds, §3.4); omit
   * it for the orchestrator. `query` (the turn's user text / a delegated
   * objective) drives the relevance prefetch when in search mode.
   *
   * At or below `searchThreshold` visible skills → the legacy full list. Above it
   * → "search mode": instruct the model to use searchSkills/useSkill, plus a
   * small relevance-ranked prefetch so the most likely skills are still inlined.
   */
  catalog(allowedToolNames?: string[], query?: string): string {
    const visible = this.visibleList(allowedToolNames);
    if (!visible.length) return '';

    const render = (s: SkillMeta): string => `- ${s.name}: ${s.description}`;

    if (visible.length <= this.searchThreshold) {
      return `Available skills (call useSkill with a skill's name to load its full instructions when relevant):\n${visible
        .map(render)
        .join('\n')}`;
    }

    const lines = [
      `You have ${visible.length} skills available — too many to list in full.`,
      'Call searchSkills(query) to find skills relevant to the task, then useSkill(name) to load a skill\'s full instructions.',
    ];
    if (query) {
      const top = this.search(query, { allowedToolNames, limit: SEARCH_MODE_PREFETCH });
      if (top.length) {
        lines.push('', 'Most relevant to the current request:', ...top.map((h) => render(h.meta)));
      }
    }
    return lines.join('\n');
  }

  /** Load a skill's full body as extra instructions (progressive disclosure). */
  load(name: string): LoadedSkill | undefined {
    const meta = this.skills.get(name);
    if (!meta) return undefined;
    return { ...meta, body: readFileSync(meta.path, 'utf8') };
  }

  /**
   * Load a skill for the `useSkill` tool, enforcing model-invocation policy.
   * Returns `not_available` when the skill exists but is withheld from this agent
   * (`disable-model-invocation`, or its `allowed-tools` aren't all in
   * `allowedToolNames` — the role hard gate, §3.4); `not_found` when there is no
   * such skill. Omit `allowedToolNames` for the orchestrator (no tool filter).
   */
  loadForModel(
    name: string,
    allowedToolNames?: string[],
  ): { name: string; body: string } | { error: 'not_found' | 'not_available' } {
    if (!this.visibleList(allowedToolNames).some((s) => s.name === name)) {
      return { error: this.skills.has(name) ? 'not_available' : 'not_found' };
    }
    const loaded = this.load(name);
    return loaded ? { name: loaded.name, body: loaded.body } : { error: 'not_found' };
  }
}
