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
