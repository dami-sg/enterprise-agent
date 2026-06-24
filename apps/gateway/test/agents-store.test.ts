/**
 * Agents filesystem store (declarative sub-agents, agent §2.3): list / read /
 * save single-file / unpack zip / enable-disable / delete, under a temp agents
 * dir. Mirrors skills-store.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentsStore } from '../src/web/agents-store.js';
import { buildZip } from './helpers.js';

const AGENT_MD = '---\nname: My Agent\ndescription: does a thing\ntools: read, exec\n---\nYou are focused.\n';

let dir: string;
let store: AgentsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-agents-'));
  store = new AgentsStore(join(dir, 'agents'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('single-file agents', () => {
  it('saves an AGENT.md (folder derived from frontmatter name), lists, reads it', () => {
    const summary = store.saveFile(AGENT_MD);
    expect(summary).toMatchObject({ dir: 'my-agent', name: 'My Agent', description: 'does a thing', enabled: true });
    expect(store.list()).toEqual([{ dir: 'my-agent', name: 'My Agent', description: 'does a thing', enabled: true }]);
    expect(store.read('my-agent')).toContain('You are focused.');
  });

  it('edits in place when given the folder, and deletes', () => {
    store.saveFile(AGENT_MD);
    store.saveFile('---\nname: Renamed\ndescription: edited\n---\nbody\n', 'my-agent');
    expect(store.list()[0]).toMatchObject({ dir: 'my-agent', name: 'Renamed', description: 'edited' });
    expect(store.remove('my-agent')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('disables an agent (renames AGENT.md so the loader skips it) and re-enables it', () => {
    store.saveFile(AGENT_MD);
    store.setEnabled('my-agent', false);
    expect(existsSync(join(dir, 'agents', 'my-agent', 'AGENT.md'))).toBe(false);
    expect(existsSync(join(dir, 'agents', 'my-agent', 'AGENT.md.disabled'))).toBe(true);
    expect(store.list()[0]).toMatchObject({ enabled: false });
    expect(store.read('my-agent')).toContain('You are focused.'); // still editable while disabled

    // Editing a disabled agent keeps it disabled.
    store.saveFile('---\nname: My Agent\ndescription: still off\n---\nx\n', 'my-agent');
    expect(store.list()[0]).toMatchObject({ enabled: false });

    store.setEnabled('my-agent', true);
    expect(existsSync(join(dir, 'agents', 'my-agent', 'AGENT.md'))).toBe(true);
    expect(store.list()[0]).toMatchObject({ enabled: true });
  });

  it('rejects an AGENT.md without name/description', () => {
    expect(() => store.saveFile('# no frontmatter')).toThrow(/frontmatter name/);
  });
});

describe('zip bundles', () => {
  it('unpacks a folder bundle (AGENT.md + assets) into the agents dir', () => {
    const zip = buildZip([
      { name: 'pkg/AGENT.md', data: Buffer.from('---\nname: Zipped\ndescription: from zip\n---\nhi'), method: 8 },
      { name: 'pkg/references/notes.md', data: Buffer.from('notes') },
    ]);
    const summary = store.addZip(zip);
    expect(summary).toMatchObject({ dir: 'zipped', name: 'Zipped' });
    expect(existsSync(join(dir, 'agents', 'zipped', 'AGENT.md'))).toBe(true);
    expect(readFileSync(join(dir, 'agents', 'zipped', 'references', 'notes.md'), 'utf8')).toBe('notes');
    expect(store.list()[0]!.name).toBe('Zipped');
  });

  it('unpacks a root bundle (AGENT.md at the zip root)', () => {
    const zip = buildZip([{ name: 'AGENT.md', data: Buffer.from('---\nname: Root\ndescription: d\n---\nx') }]);
    expect(store.addZip(zip)).toMatchObject({ dir: 'root', name: 'Root' });
    expect(existsSync(join(dir, 'agents', 'root', 'AGENT.md'))).toBe(true);
  });

  it('rejects a zip without AGENT.md', () => {
    expect(() => store.addZip(buildZip([{ name: 'readme.txt', data: Buffer.from('x') }]))).toThrow(/AGENT\.md/);
  });
});
