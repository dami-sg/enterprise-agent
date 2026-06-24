import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry, buildSeedAgents } from '../src/agents/registry.js';
import { SUB_AGENT_ROLE_NAMES } from '../src/runtime/prompts.js';

/** Write an `<root>/<name>/AGENT.md` with the given contents. */
function writeAgent(root: string, name: string, md: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENT.md'), md, 'utf8');
}

describe('AgentRegistry — built-in seeds', () => {
  it('with no disk roots, exposes exactly the five built-in roles (zero regression)', () => {
    const reg = new AgentRegistry(buildSeedAgents(), []);
    expect(reg.names().sort()).toEqual([...SUB_AGENT_ROLE_NAMES].sort());
    for (const name of SUB_AGENT_ROLE_NAMES) {
      const def = reg.get(name)!;
      expect(def.builtin).toBe(true);
      expect(def.prompt.length).toBeGreaterThan(0);
      // Seeds are nest-capable so admin `delegateAgents` stays the sole gate.
      expect(def.policy.delegate).toBe(true);
    }
  });

  it('catalog lists every agent as "- name: description"', () => {
    const reg = new AgentRegistry(buildSeedAgents(), []);
    const cat = reg.catalog();
    for (const name of SUB_AGENT_ROLE_NAMES) expect(cat).toContain(`- ${name}:`);
  });
});

describe('AgentRegistry — disk AGENT.md discovery & frontmatter→policy', () => {
  it('parses capability tokens, mcp allowlist, delegate, model, timeout-ms', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-agents-'));
    writeAgent(
      root,
      'compliance-reviewer',
      [
        '---',
        'name: compliance-reviewer',
        'description:审阅合规红线',
        'tools: read, exec',
        'mcp: policy-server, jira',
        'delegate: true',
        'model: sonnet',
        'timeout-ms: 180000',
        '---',
        'You are a compliance review sub-agent.',
      ].join('\n'),
    );
    const reg = new AgentRegistry(buildSeedAgents(), [root]);
    const def = reg.get('compliance-reviewer')!;
    expect(def.builtin).toBe(false);
    expect(def.policy.file).toEqual({ read: true, write: false });
    expect(def.policy.exec).toBe(true);
    expect(def.policy.http).toBe(false);
    expect(def.policy.delegate).toBe(true);
    expect(def.policy.mcp).toEqual(['policy-server', 'jira']);
    expect(def.model).toBe('sonnet');
    expect(def.timeoutMs).toBe(180000);
    expect(def.prompt).toBe('You are a compliance review sub-agent.');
  });

  it('mcp: true → all; absent → none; delegate defaults false', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-agents-'));
    writeAgent(root, 'all-mcp', '---\nname: all-mcp\ndescription: d\ntools: read\nmcp: true\n---\nbody');
    writeAgent(root, 'no-mcp', '---\nname: no-mcp\ndescription: d\ntools: read\n---\nbody');
    const reg = new AgentRegistry(buildSeedAgents(), [root]);
    expect(reg.get('all-mcp')!.policy.mcp).toBe(true);
    expect(reg.get('no-mcp')!.policy.mcp).toBe(false);
    expect(reg.get('no-mcp')!.policy.delegate).toBe(false);
  });

  it('a disk definition overrides a built-in seed by name', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-agents-'));
    // Narrow the built-in coder: read-only, no exec/write, named MCP only.
    writeAgent(root, 'coder', '---\nname: coder\ndescription: locked-down\ntools: read\nmcp: github\n---\nbe careful');
    const reg = new AgentRegistry(buildSeedAgents(), [root]);
    const coder = reg.get('coder')!;
    expect(coder.builtin).toBe(false);
    expect(coder.policy.exec).toBe(false);
    expect(coder.policy.file.write).toBe(false);
    expect(coder.policy.mcp).toEqual(['github']);
    // Still exactly five names (override, not addition).
    expect(reg.names()).toHaveLength(SUB_AGENT_ROLE_NAMES.length);
  });

  it('fail-closed: missing name/description dropped; unknown tool token ignored', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-agents-'));
    writeAgent(root, 'broken', '---\ndescription: no name here\ntools: read\n---\nbody');
    writeAgent(root, 'weird-tools', '---\nname: weird-tools\ndescription: d\ntools: read, sudo, exec\n---\nbody');
    const reg = new AgentRegistry(buildSeedAgents(), [root]);
    // 'broken' has no name → not registered.
    expect(reg.get('broken')).toBeUndefined();
    // Unknown 'sudo' token is silently dropped; read+exec survive.
    const wt = reg.get('weird-tools')!;
    expect(wt.policy.file.read).toBe(true);
    expect(wt.policy.exec).toBe(true);
    expect(wt.policy.http).toBe(false);
  });
});
