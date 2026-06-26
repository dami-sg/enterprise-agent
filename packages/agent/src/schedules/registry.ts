/**
 * Schedule definitions (§7 定时编排). A schedule is a directory with a
 * `SCHEDULE.md` (frontmatter: cron/every + targeting + delivery; body: the goal
 * prompt sent to the session), discovered like skills/agents. The definition is
 * declarative and immutable; mutable run state (last/next run) lives separately in
 * the ScheduleStore so a redeploy of the definition never loses durability.
 *
 * KEY SAFETY (§7 B.2): scheduled runs are UNATTENDED — there is no human to answer
 * an approval. The scheduler forces `auto` mode and (B-P3) degrades `ask` → deny,
 * so a schedule never blocks on a prompt that will never be answered.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionMode } from '@enterprise-agent/agent-contract';
import { listDirs } from '../util/fs.js';
import { parseFrontmatter } from '../skills/loader.js';

/** How a fired schedule binds to a session. */
export type ScheduleSession = { kind: 'fresh' } | { kind: 'reuse'; id: string };

/** A resolved schedule definition (one `SCHEDULE.md`). */
export interface ScheduleDef {
  /** Kebab id; the schedule's identity for state + manual run. */
  name: string;
  /** Optional one-line summary for listings. */
  description?: string;
  /** Standard 5-field cron expression (B-P2 parses it); `every` is an alternative. */
  cron?: string;
  /** Coarse interval alternative to `cron` (e.g. `1d`, `6h`, `30m`). */
  every?: string;
  /** IANA timezone for cron evaluation; the host local zone when omitted. */
  timezone?: string;
  /** Execution mode for the unattended run (§7 B.2). Defaults to `auto`. */
  mode: ExecutionMode;
  /** Optional agent definition to run the goal through (else the orchestrator). */
  agent?: string;
  /** Session binding: a fresh session each run, or reuse a pinned session. */
  session: ScheduleSession;
  /** Host delivery target for the result (e.g. `weixin:ops`); B-P3 routes it. */
  deliverTo?: string;
  /** Pre-authorized grant scopes for unattended high-risk ops (B-P3). */
  grants?: string[];
  /**
   * Catch-up policy when a fire window was MISSED (e.g. the host was down past it):
   * `run-once` (default) fires once on the next tick then re-arms; `skip` does not
   * fire a stale window — it just re-arms to the next future slot. On-time fires
   * are unaffected by this. (§7 B.4)
   */
  onMissed: 'run-once' | 'skip';
  /** Whether the scheduler considers this schedule at all. */
  enabled: boolean;
  /** The `SCHEDULE.md` body = the goal/prompt sent to the session when fired. */
  goal: string;
  /** Directory holding the definition. */
  dir: string;
}

const EXECUTION_MODES = new Set<ExecutionMode>(['ask', 'plan', 'auto', 'full']);

/** Parse the `session:` frontmatter (`fresh` | `reuse:<id>`); default fresh. */
function parseSession(raw: unknown): ScheduleSession {
  if (typeof raw === 'string') {
    const v = raw.trim();
    if (v.startsWith('reuse:')) {
      const id = v.slice('reuse:'.length).trim();
      if (id) return { kind: 'reuse', id };
    }
  }
  return { kind: 'fresh' };
}

/** Normalize a frontmatter list value (array | comma string) to a string list. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Read one `<dir>/SCHEDULE.md` into a ScheduleDef, or undefined if absent/invalid. */
function readSchedule(dir: string): ScheduleDef | undefined {
  const path = join(dir, 'SCHEDULE.md');
  if (!existsSync(path)) return undefined;
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  if (typeof fm.name !== 'string' || !fm.name.trim()) return undefined;
  // Unattended → auto unless an explicit, recognized mode is set (fail-safe: an
  // unknown mode string falls back to auto rather than a hanging `ask`).
  const rawMode = typeof fm.mode === 'string' ? (fm.mode.trim() as ExecutionMode) : undefined;
  const mode: ExecutionMode = rawMode && EXECUTION_MODES.has(rawMode) ? rawMode : 'auto';
  const grants = toList(fm.grants);
  return {
    name: fm.name.trim(),
    description: typeof fm.description === 'string' ? fm.description : undefined,
    cron: typeof fm.cron === 'string' && fm.cron.trim() ? fm.cron.trim() : undefined,
    every: typeof fm.every === 'string' && fm.every.trim() ? fm.every.trim() : undefined,
    timezone: typeof fm.timezone === 'string' && fm.timezone.trim() ? fm.timezone.trim() : undefined,
    mode,
    agent: typeof fm.agent === 'string' && fm.agent.trim() ? fm.agent.trim() : undefined,
    session: parseSession(fm.session),
    deliverTo: typeof fm['deliver-to'] === 'string' && fm['deliver-to'].trim() ? fm['deliver-to'].trim() : undefined,
    grants: grants.length ? grants : undefined,
    onMissed: fm['on-missed'] === 'skip' ? 'skip' : 'run-once',
    enabled: fm.enabled !== false,
    goal: body.trim(),
    dir,
  };
}

/** Discover schedule definitions across one or more roots (later roots override). */
export class ScheduleRegistry {
  private schedules = new Map<string, ScheduleDef>();

  constructor(scheduleRoots: string[]) {
    for (const root of scheduleRoots) {
      for (const name of listDirs(root)) {
        const def = readSchedule(join(root, name));
        if (def) this.schedules.set(def.name, def); // later roots override by name
      }
    }
  }

  list(): ScheduleDef[] {
    return [...this.schedules.values()];
  }

  get(name: string): ScheduleDef | undefined {
    return this.schedules.get(name);
  }
}
