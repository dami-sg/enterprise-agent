import { describe, it, expect, vi } from 'vitest';
import { buildToolsForAgent, mcpAllowedForPolicy, mcpAllowForPolicy } from '../src/tools/registry.js';
import { buildSubResult, buildTimeoutResult, isNoOutputError } from '../src/runtime/sub-agent.js';
import { buildFileTools } from '../src/tools/file.js';
import { timeoutForRole } from '../src/config/store.js';
import { buildSeedAgents, type AgentDef } from '../src/agents/registry.js';
import { ROLE_TOOL_POLICY, SUB_AGENT_ROLE_NAMES, type RoleToolPolicy, type SubAgentRole } from '../src/runtime/prompts.js';
import type { RunContext } from '../src/runtime/context.js';

const ROLES: SubAgentRole[] = [...SUB_AGENT_ROLE_NAMES];

/** The built-in seed AgentDef for a role — the source of truth post-refactor. */
const SEEDS = new Map(buildSeedAgents().map((d) => [d.name, d]));
const seed = (role: string): AgentDef => SEEDS.get(role)!;
/** A minimal policy carrying only the `mcp` field under test. */
const mcpPolicy = (mcp: RoleToolPolicy['mcp']): RoleToolPolicy => ({
  file: { read: true, write: false },
  exec: false,
  http: false,
  delegate: false,
  mcp,
});

/** Minimal context: tool builders only touch these fields at construction. */
function fakeCtx(over: { depth?: number; maxDepth?: number; delegateAgents?: string[] } = {}): RunContext {
  return {
    shared: {
      rootPaths: ['/tmp/work'],
      sandbox: {},
      sandboxPolicy: {},
      permission: {},
      maxDepth: over.maxDepth ?? 3,
      delegateAgents: new Set(over.delegateAgents ?? []),
    },
    depth: over.depth ?? 1,
    abortSignal: new AbortController().signal,
  } as unknown as RunContext;
}

describe('Role tool hard gate (agent §2.3 / §3.4)', () => {
  it('researcher gets read + http only, never write/exec', () => {
    const t = buildToolsForAgent(seed('researcher'), fakeCtx());
    expect(Object.keys(t).sort()).toEqual([
      'getCurrentTime',
      'httpFetch',
      'listDir',
      'readFile',
      'search',
      'searchSkills',
      'useSkill',
    ]);
  });

  it('coder gets read + write + exec, but no http', () => {
    const t = buildToolsForAgent(seed('coder'), fakeCtx());
    expect(Object.keys(t).sort()).toEqual([
      'applyPatch',
      'getCurrentTime',
      'listDir',
      'readFile',
      'runCommand',
      'search',
      'searchSkills',
      'useSkill',
      'writeFile',
    ]);
  });

  it('analyst gets read + exec, no write/http', () => {
    const t = buildToolsForAgent(seed('analyst'), fakeCtx());
    expect(Object.keys(t).sort()).toEqual([
      'getCurrentTime',
      'listDir',
      'readFile',
      'runCommand',
      'search',
      'searchSkills',
      'useSkill',
    ]);
  });

  it('writer gets read + write, no exec/http', () => {
    const t = buildToolsForAgent(seed('writer'), fakeCtx());
    expect(Object.keys(t).sort()).toEqual([
      'applyPatch',
      'getCurrentTime',
      'listDir',
      'readFile',
      'search',
      'searchSkills',
      'useSkill',
      'writeFile',
    ]);
  });

  it('generalist gets the FULL kit: read + write + exec + http (maximal set, agent §2.3)', () => {
    const t = buildToolsForAgent(seed('generalist'), fakeCtx());
    expect(Object.keys(t).sort()).toEqual([
      'applyPatch',
      'getCurrentTime',
      'httpFetch',
      'listDir',
      'readFile',
      'runCommand',
      'search',
      'searchSkills',
      'useSkill',
      'writeFile',
    ]);
  });

  it('no role exposes write tools it is not granted (monotonic restriction)', () => {
    for (const role of ROLES) {
      const policy = ROLE_TOOL_POLICY[role];
      const t = buildToolsForAgent(seed(role), fakeCtx());
      expect('writeFile' in t).toBe(policy.file.write);
      expect('runCommand' in t).toBe(policy.exec);
      expect('httpFetch' in t).toBe(policy.http);
    }
  });
});

describe('MCP role allowlist (agent §3.4 / §3.5)', () => {
  it('mcp: true → allowed, predicate is undefined (allow all)', () => {
    // All built-in seed roles currently use mcp: true.
    for (const role of ROLES) {
      expect(mcpAllowedForPolicy(seed(role).policy)).toBe(true);
      expect(mcpAllowForPolicy(seed(role).policy)).toBeUndefined();
    }
  });

  it('mcp: false → not allowed, predicate rejects everything', () => {
    const policy = mcpPolicy(false);
    expect(mcpAllowedForPolicy(policy)).toBe(false);
    const allow = mcpAllowForPolicy(policy)!;
    expect(allow('mcp__github__create_issue')).toBe(false);
  });

  it('mcp: string[] → predicate filters by server segment', () => {
    const policy = mcpPolicy(['github', 'jira']);
    expect(mcpAllowedForPolicy(policy)).toBe(true);
    const allow = mcpAllowForPolicy(policy)!;
    expect(allow('mcp__github__create_issue')).toBe(true);
    expect(allow('mcp__jira__search')).toBe(true);
    expect(allow('mcp__slack__post')).toBe(false);
    expect(allow('malformed')).toBe(false);
  });

  it('empty mcp allowlist → not allowed at all', () => {
    expect(mcpAllowedForPolicy(mcpPolicy([]))).toBe(false);
  });
});

describe('Nested delegation gate (agent §2.3 pt.2, config-driven)', () => {
  it('delegate tool is withheld when the role is not in the config set, even with a factory', () => {
    const factory = vi.fn(() => ({}) as any);
    for (const role of ROLES) {
      // delegateAgents defaults to empty → no role nests.
      const t = buildToolsForAgent(seed(role), fakeCtx(), factory);
      expect('delegateToSubAgent' in t).toBe(false);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('delegate tool is wired when the config opts the role in and depth budget remains', () => {
    const sentinel = { __delegate: true } as any;
    const factory = vi.fn(() => sentinel);
    const t = buildToolsForAgent(
      seed('researcher'),
      fakeCtx({ depth: 1, maxDepth: 3, delegateAgents: ['researcher'] }),
      factory,
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(t.delegateToSubAgent).toBe(sentinel);
  });

  it('only the named roles are opted in; others stay gated', () => {
    const factory = vi.fn(() => ({}) as any);
    const ctx = (role: SubAgentRole) =>
      buildToolsForAgent(seed(role), fakeCtx({ delegateAgents: ['coder'] }), factory);
    expect('delegateToSubAgent' in ctx('coder')).toBe(true);
    expect('delegateToSubAgent' in ctx('researcher')).toBe(false);
  });

  it('delegate tool is withheld at the depth limit even when the role is opted in', () => {
    const factory = vi.fn(() => ({}) as any);
    // depth === maxDepth → no budget left to spawn another level.
    const t = buildToolsForAgent(
      seed('researcher'),
      fakeCtx({ depth: 3, maxDepth: 3, delegateAgents: ['researcher'] }),
      factory,
    );
    expect('delegateToSubAgent' in t).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('no factory (e.g. depth-exhausted spawn site) → never wired regardless of config', () => {
    const t = buildToolsForAgent(seed('researcher'), fakeCtx({ delegateAgents: ['researcher'] }));
    expect('delegateToSubAgent' in t).toBe(false);
  });

  it('an agent that does not opt into delegate never gets the tool, even if admin-listed', () => {
    // New AND-gate (§2.3): nesting requires BOTH the agent's own `delegate`
    // opt-in AND admin config. A custom AGENT.md with `delegate: false` stays
    // gated regardless of delegateAgents.
    const factory = vi.fn(() => ({}) as any);
    const noDelegate: AgentDef = {
      ...seed('researcher'),
      policy: { ...seed('researcher').policy, delegate: false },
    };
    const t = buildToolsForAgent(noDelegate, fakeCtx({ delegateAgents: ['researcher'] }), factory);
    expect('delegateToSubAgent' in t).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('Sub-agent result shaping (empty output is not a silent "")', () => {
  it('passes real text output straight through, no note', () => {
    const r = buildSubResult('researcher', 'findings here', 4);
    expect(r).toEqual({ role: 'researcher', output: 'findings here', steps: 4 });
  });

  it('passes the real step count through (not a hardcoded 0)', () => {
    const r = buildSubResult('analyst', '', 7);
    expect(r.steps).toBe(7);
  });

  it('0 steps → blames model/provider config, NOT a missing tool', () => {
    const r = buildSubResult('analyst', '', 0);
    expect(r.note).toMatch(/0 steps|model\/provider config|did not execute/i);
    expect(r.note).not.toMatch(/web_search/i);
  });

  it('a streamed error is surfaced verbatim, not masked by a generic template', () => {
    const r = buildSubResult('coder', '', 2, { error: '401 invalid api key' });
    expect(r.error).toBe('401 invalid api key');
    expect(r.note).toContain('401 invalid api key');
    expect(r.note).not.toMatch(/web_search/i);
  });

  it("finishReason 'length' → blames the output-token budget", () => {
    const r = buildSubResult('writer', '', 5, { finishReason: 'length' });
    expect(r.note).toMatch(/output-token limit|maxOutputTokens/i);
  });

  it('non-researcher ran-but-silent note does NOT mention web_search', () => {
    const r = buildSubResult('analyst', '', 3);
    expect(r.note).toMatch(/without final text/i);
    expect(r.note).not.toMatch(/web_search/i);
  });

  it('only researcher ran-but-silent note hints at the missing web_search tool', () => {
    const r = buildSubResult('researcher', '', 3);
    expect(r.note).toMatch(/web_search|search MCP/i);
  });
});

describe('Sub-agent timeout result (agent §2.3 wall-clock cap)', () => {
  it('returns an explicit error:"timeout" carrying any partial text, not a silent block', () => {
    const r = buildTimeoutResult('researcher', 'partial findings so far', 300000);
    expect(r.error).toBe('timeout');
    expect(r.timeoutMs).toBe(300000);
    expect(r.output).toBe('partial findings so far');
    expect(r.note).toMatch(/timeout|narrowing|subAgentTimeoutMs/i);
  });

  it('still reports timeout when nothing was streamed before the abort', () => {
    const r = buildTimeoutResult('coder', '', 5000);
    expect(r).toMatchObject({ role: 'coder', error: 'timeout', timeoutMs: 5000, output: '' });
  });
});

describe('No-output detection (AI SDK error → graceful note)', () => {
  it('matches the AI SDK error by name and by message', () => {
    expect(isNoOutputError({ name: 'AI_NoOutputGeneratedError' })).toBe(true);
    expect(isNoOutputError(new Error('No output generated.'))).toBe(true);
  });
  it('does not match unrelated errors', () => {
    expect(isNoOutputError(new Error('network down'))).toBe(false);
    expect(isNoOutputError(undefined)).toBe(false);
  });
});

describe('File tools return a structured out-of-boundary error (no throw)', () => {
  const ctx = { shared: { rootPaths: ['/tmp/work'] } } as unknown as RunContext;
  const tools = buildFileTools(ctx);

  it('readFile on an out-of-boundary path returns {error:out_of_boundary}, not a throw', async () => {
    const r = await (tools.readFile.execute as any)({ path: '/etc/passwd' }, {});
    expect(r).toMatchObject({ error: 'out_of_boundary', path: '/etc/passwd' });
    expect(r.roots).toEqual(['/tmp/work']);
  });

  it('listDir and search also fail soft on out-of-boundary paths', async () => {
    const ld = await (tools.listDir.execute as any)({ path: '/var' }, {});
    expect(ld).toMatchObject({ error: 'out_of_boundary' });
    const se = await (tools.search.execute as any)({ query: 'x', path: '/usr' }, {});
    expect(se).toMatchObject({ error: 'out_of_boundary' });
  });
});

describe('Per-role timeout resolution (timeoutForRole)', () => {
  const eff = { subAgentTimeoutMs: 300000, roleTimeoutMs: { researcher: 600000, coder: 0 } };

  it('uses the per-role override when present', () => {
    expect(timeoutForRole(eff, 'researcher')).toBe(600000);
  });

  it('a per-role override of 0 disables the timeout for just that role', () => {
    expect(timeoutForRole(eff, 'coder')).toBe(0);
  });

  it('falls back to the global default for roles without an override', () => {
    expect(timeoutForRole(eff, 'analyst')).toBe(300000);
    expect(timeoutForRole(eff, 'writer')).toBe(300000);
  });
});
