/**
 * Agent definitions (declarative sub-agents). An "agent" is a directory with an
 * `AGENT.md` (frontmatter → tool policy + model, body → system prompt), mirroring
 * the Skills standard (§3.6, see skills/loader.ts). The built-in roles
 * (`researcher` / `coder` / … / `generalist`) are registered as `builtin` seeds,
 * so behaviour with NO disk `agents/` dir is byte-identical to the old fixed
 * `SUB_AGENT_ROLE_NAMES` enum. Disk definitions are discovered + merged like
 * skills (later roots override by name) and can only *narrow* capability — the
 * role hard gate (§3.4) still constructs only the tools a policy permits, and
 * every tool stays bound by approval + sandbox + the "子 ≤ 父" invariant.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { listDirs } from '../util/fs.js';
import { parseFrontmatter } from '../skills/loader.js';
import {
  ROLE_TOOL_POLICY,
  SUB_AGENT_PROMPTS,
  SUB_AGENT_ROLE_NAMES,
  type RoleToolPolicy,
} from '../runtime/prompts.js';

/** A resolved agent definition: a seed (built-in role) or a disk `AGENT.md`. */
export interface AgentDef {
  /** Kebab id; the `delegateToSubAgent` role value and the `sub-<name>-<n>` id. */
  name: string;
  /** One line shown in the delegate tool's catalog so the orchestrator can pick. */
  description: string;
  /** Tool capability hard gate (§3.4), derived from frontmatter. */
  policy: RoleToolPolicy;
  /** The agent's system prompt (the `AGENT.md` body). */
  prompt: string;
  /** Optional model override (alias or `provider:model` ref); else role default. */
  model?: string;
  /** Optional wall-clock timeout (ms) override; else the role/config default. */
  timeoutMs?: number;
  /** Directory holding the definition (`<builtin>` for seeds). */
  dir: string;
  /** True for the five built-in seeds (cannot be deleted, only overridden). */
  builtin: boolean;
}

/** Capability tokens accepted in `AGENT.md` frontmatter `tools:`. */
const CAP_TOKENS = new Set(['read', 'write', 'exec', 'http']);

/** Normalize a frontmatter value (array | comma string | undefined) to a token list. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return [];
}

/**
 * frontmatter → RoleToolPolicy. Unknown capability tokens are dropped
 * (fail-closed): a malformed `tools:` can only ever yield a NARROWER policy,
 * never escalate. `mcp`: `true` (all) | `false`/absent (none) | server allowlist.
 */
function parsePolicy(fm: Record<string, unknown>): RoleToolPolicy {
  const tools = toList(fm.tools).filter((t) => CAP_TOKENS.has(t));
  const has = (t: string): boolean => tools.includes(t);
  let mcp: boolean | string[];
  if (fm.mcp === true) mcp = true;
  else if (fm.mcp === false || fm.mcp === undefined) mcp = false;
  else {
    const list = toList(fm.mcp);
    mcp = list.length ? list : false;
  }
  return {
    file: { read: has('read'), write: has('write') },
    exec: has('exec'),
    http: has('http'),
    delegate: fm.delegate === true,
    mcp,
  };
}

/** Read one `<dir>/AGENT.md` into an AgentDef, or undefined if absent/invalid. */
function readAgent(dir: string): AgentDef | undefined {
  const path = join(dir, 'AGENT.md');
  if (!existsSync(path)) return undefined;
  const { fm, body } = parseFrontmatter(readFileSync(path, 'utf8'));
  // name + description are required (mirrors SKILL.md); without them the
  // definition is dropped rather than half-registered (fail-closed).
  if (typeof fm.name !== 'string' || typeof fm.description !== 'string') return undefined;
  const rawTimeout = fm['timeout-ms'];
  const timeoutMs =
    typeof rawTimeout === 'string' && /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : undefined;
  return {
    name: fm.name,
    description: fm.description,
    policy: parsePolicy(fm),
    prompt: body.trim(),
    model: typeof fm.model === 'string' && fm.model ? fm.model : undefined,
    timeoutMs,
    dir,
    builtin: false,
  };
}

/** One-line catalog descriptions for the built-in seeds (delegate tool listing). */
const SEED_DESCRIPTIONS: Record<string, string> = {
  researcher: 'read-only files + httpFetch + MCP — investigate and summarize; cannot write or run commands.',
  coder: 'read/write files + run commands + MCP — implement bounded code changes.',
  analyst: 'read-only files + read-only commands + MCP — analyze data/files and report findings.',
  writer: 'read/write files + MCP — produce or refine prose/documentation.',
  generalist: 'the FULL tool kit — read/write + commands + network + MCP — for sub-tasks needing a broad mix.',
};

/**
 * The five built-in roles as `builtin` seeds. Policy is derived from
 * `ROLE_TOOL_POLICY` verbatim EXCEPT `delegate`, forced `true`: the pre-refactor
 * nesting gate was config-only (`delegateAgents`), so built-ins must keep their
 * per-agent opt-in implicit, leaving admin config as the sole control. Default
 * `delegateAgents` stays `[]` (see store.defaultDelegateAgents), so nothing nests
 * unless an admin enables it — behaviour is unchanged.
 */
export function buildSeedAgents(): AgentDef[] {
  return SUB_AGENT_ROLE_NAMES.map((name) => {
    const p = ROLE_TOOL_POLICY[name];
    return {
      name,
      description: SEED_DESCRIPTIONS[name] ?? name,
      policy: { file: { ...p.file }, exec: p.exec, http: p.http, delegate: true, mcp: p.mcp },
      prompt: SUB_AGENT_PROMPTS[name],
      dir: '<builtin>',
      builtin: true,
    } satisfies AgentDef;
  });
}

/** Discover + merge agent definitions: built-in seeds, then disk roots (override). */
export class AgentRegistry {
  private agents = new Map<string, AgentDef>();

  /**
   * `seeds` first (built-ins), then each root (global → workspace → session).
   * `enabledDisk` is the admin allowlist of enabled DISK agents (config `agents`):
   * `undefined` = all enabled; a list = only those disk names. Built-in seeds are
   * always registered regardless (they can be overridden but never disabled).
   */
  constructor(seeds: AgentDef[], agentRoots: string[], enabledDisk?: string[]) {
    for (const s of seeds) this.agents.set(s.name, s);
    const allow = enabledDisk ? new Set(enabledDisk) : undefined;
    for (const root of agentRoots) {
      for (const name of listDirs(root)) {
        const def = readAgent(join(root, name));
        if (!def) continue;
        // Skip a disk def the admin allowlist excludes — UNLESS it overrides a
        // built-in seed (overriding a built-in is always honored; the allowlist
        // gates the introduction of NEW agents, not edits to existing ones).
        if (allow && !allow.has(def.name) && !this.agents.get(def.name)?.builtin) continue;
        this.agents.set(def.name, def); // later roots override by name
      }
    }
  }

  list(): AgentDef[] {
    return [...this.agents.values()];
  }

  get(name: string): AgentDef | undefined {
    return this.agents.get(name);
  }

  /** All agent names — the source for the `delegateToSubAgent` input `z.enum`. */
  names(): string[] {
    return [...this.agents.keys()];
  }

  /** The "available agents" block injected into the delegate tool description. */
  catalog(): string {
    return this.list()
      .map((d) => `- ${d.name}: ${d.description}`)
      .join('\n');
  }
}
