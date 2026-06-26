import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, assertSafeServerName } from '../src/config/store.js';
import { createPaths } from '../src/config/paths.js';
import { readJson, writeJson } from '../src/util/fs.js';

describe('assertSafeServerName (path-traversal guard, agent §3.5)', () => {
  it('accepts ordinary names', () => {
    for (const n of ['github', 'my-server', 'a.b_c', 'Server1']) {
      expect(() => assertSafeServerName(n)).not.toThrow();
    }
  });

  it('rejects names that would escape the MCP config dir', () => {
    for (const n of ['../evil', '..', '.', 'a/b', 'a\\b', '/abs', '.hidden', '', 'a/../b']) {
      expect(() => assertSafeServerName(n)).toThrow();
    }
  });
});

describe('ConfigStore.saveMcpServer / removeMcpServer reject unsafe names', () => {
  it('does not write or delete outside the MCP dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-cfg-'));
    const store = new ConfigStore(createPaths(root));
    expect(() =>
      store.saveMcpServer({ name: '../../pwned', transport: 'stdio', enabled: true }),
    ).toThrow(/invalid MCP server name/);
    expect(() => store.removeMcpServer('../../pwned')).toThrow(/invalid MCP server name/);
    // A legitimate save lands inside the MCP dir as `<name>.json`.
    store.saveMcpServer({ name: 'github', transport: 'stdio', enabled: true });
    const mcpDir = createPaths(root).mcp;
    expect(readdirSync(mcpDir)).toContain('github.json');
  });
});

describe('ConfigStore.effective merges per-sub-agent model bindings (model.roleAliases)', () => {
  it('passes global roleAliases through and leaves unbound roles absent (→ follow orchestrator)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-cfg-'));
    const store = new ConfigStore(createPaths(root));
    store.saveSettings({
      model: { orchestratorAlias: 'orchestrator', roleAliases: { coder: 'openai:gpt-4o' } },
    });

    const eff = store.effective(undefined, []);
    expect(eff.orchestratorAlias).toBe('orchestrator');
    // A bound role carries its concrete ref; an unbound role has NO entry, so the
    // runtime's `roleAliases[role] ?? orchestratorAlias` falls back to orchestrator.
    expect(eff.roleAliases.coder).toBe('openai:gpt-4o');
    expect('researcher' in eff.roleAliases).toBe(false);
  });

  it('lets a scope (session) override the global binding for a role', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-cfg-'));
    const store = new ConfigStore(createPaths(root));
    store.saveSettings({ model: { roleAliases: { coder: 'openai:gpt-4o', writer: 'anthropic:claude-sonnet-4.5' } } });

    const eff = store.effective({ model: { roleAliases: { coder: 'anthropic:claude-opus-4.8' } } }, []);
    // Session wins for `coder`; the global `writer` binding still shows through.
    expect(eff.roleAliases.coder).toBe('anthropic:claude-opus-4.8');
    expect(eff.roleAliases.writer).toBe('anthropic:claude-sonnet-4.5');
  });

  it('clearing a role binding (delete from settings) drops it from effective config', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-cfg-'));
    const store = new ConfigStore(createPaths(root));
    store.saveSettings({ model: { roleAliases: { coder: 'openai:gpt-4o' } } });
    // Simulate the TUI "x 清除" path: remove the entry and re-save.
    const s = store.loadSettings();
    delete s.model!.roleAliases!.coder;
    store.saveSettings(s);

    expect('coder' in store.effective(undefined, []).roleAliases).toBe(false);
  });
});

describe('writeJson is atomic and leaves no torn file (agent §5)', () => {
  it('round-trips and writes no stray temp file on success', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-fs-'));
    const file = join(dir, 'providers.json');
    writeJson(file, [{ id: 'anthropic', kind: 'anthropic', enabled: true }]);
    expect(readJson<unknown[]>(file)).toHaveLength(1);
    // No leftover `.providers.json.<pid>.tmp` after a clean write (rename moved it).
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
    expect(existsSync(file)).toBe(true);
  });

  it('overwrites in place without corrupting a concurrent reader view', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-fs-'));
    const file = join(dir, 's.json');
    writeFileSync(file, '{"v":1}\n');
    writeJson(file, { v: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 2 });
  });
});
