import { describe, it, expect } from 'vitest';
import { buildToolsForAgent, mcpAllowedForPolicy, mcpAllowForPolicy } from '../src/tools/registry.js';
import { buildSubResult, buildTimeoutResult, isNoOutputError } from '../src/runtime/sub-agent.js';
import { buildFileTools } from '../src/tools/file.js';
import { policyFromCapabilities, type AgentDef } from '../src/agents/registry.js';
import type { RoleToolPolicy } from '../src/runtime/prompts.js';
import type { SubAgentCapability } from '@dami-sg/agent-contract';
import type { RunContext } from '../src/runtime/context.js';

/** An ephemeral AgentDef for the given capabilities (dynamic-subagents §D1). */
function def(name: string, caps: SubAgentCapability[], mcp: false | string[] = false): AgentDef {
  return { name, description: '', policy: policyFromCapabilities(caps, mcp), prompt: 'p', dir: '<dynamic>', builtin: false };
}

/** A minimal policy carrying only the `mcp` field under test. */
const mcpPolicy = (mcp: RoleToolPolicy['mcp']): RoleToolPolicy => ({
  file: { read: true, write: false },
  exec: false,
  http: false,
  delegate: false,
  mcp,
});

/** Minimal context: tool builders only touch these fields at construction. */
function fakeCtx(): RunContext {
  return {
    shared: { rootPaths: ['/tmp/work'], sandbox: {}, sandboxPolicy: {}, permission: {} },
    depth: 1,
    abortSignal: new AbortController().signal,
  } as unknown as RunContext;
}

describe('Capability hard gate (dynamic-subagents §D2 / agent §3.4)', () => {
  it('read + http → only read tools + httpFetch (never write/exec)', () => {
    const t = buildToolsForAgent(def('r', ['read', 'http']), fakeCtx());
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

  it('read + write + exec → file r/w + runCommand, but no http', () => {
    const t = buildToolsForAgent(def('c', ['read', 'write', 'exec']), fakeCtx());
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

  it('read + exec → read tools + runCommand, no write/http', () => {
    const t = buildToolsForAgent(def('a', ['read', 'exec']), fakeCtx());
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

  it('the full kit (read + write + exec + http) constructs every local tool', () => {
    const t = buildToolsForAgent(def('g', ['read', 'write', 'exec', 'http']), fakeCtx());
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

  it('a sub-agent NEVER receives delegateToSubAgent (no nesting, §D3)', () => {
    for (const caps of [['read'], ['read', 'write', 'exec', 'http']] as SubAgentCapability[][]) {
      const t = buildToolsForAgent(def('x', caps), fakeCtx());
      expect('delegateToSubAgent' in t).toBe(false);
    }
  });

  it('out-of-capability tools are never constructed (monotonic restriction)', () => {
    const combos: SubAgentCapability[][] = [['read'], ['read', 'http'], ['read', 'write'], ['read', 'exec']];
    for (const caps of combos) {
      const t = buildToolsForAgent(def('x', caps), fakeCtx());
      expect('writeFile' in t).toBe(caps.includes('write'));
      expect('runCommand' in t).toBe(caps.includes('exec'));
      expect('httpFetch' in t).toBe(caps.includes('http'));
    }
  });
});

describe('MCP allowlist gate (agent §3.4 / §3.5)', () => {
  it('mcp: true → allowed, predicate is undefined (allow all)', () => {
    expect(mcpAllowedForPolicy(mcpPolicy(true))).toBe(true);
    expect(mcpAllowForPolicy(mcpPolicy(true))).toBeUndefined();
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

  it('policyFromCapabilities carries the MCP allowlist through to the gate', () => {
    expect(mcpAllowedForPolicy(def('x', ['read'], ['jira']).policy)).toBe(true);
    expect(mcpAllowedForPolicy(def('x', ['read'], false).policy)).toBe(false);
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
