/**
 * Skills filesystem store (gateway §7): list / read / save single-file / unpack
 * zip / delete, all under a temp skills dir.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsStore } from '../src/web/skills-store.js';
import { buildZip } from './helpers.js';

const SKILL_MD = '---\nname: My Skill\ndescription: does a thing\n---\n# Steps\nDo it.\n';

let dir: string;
let store: SkillsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-skills-'));
  store = new SkillsStore(join(dir, 'skills'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('single-file skills', () => {
  it('saves a SKILL.md (folder derived from frontmatter name), lists, reads it', () => {
    const summary = store.saveFile(SKILL_MD);
    expect(summary).toMatchObject({ dir: 'my-skill', name: 'My Skill', description: 'does a thing', enabled: true });
    expect(store.list()).toEqual([{ dir: 'my-skill', name: 'My Skill', description: 'does a thing', enabled: true }]);
    expect(store.read('my-skill')).toContain('# Steps');
  });

  it('edits in place when given the folder, and deletes', () => {
    store.saveFile(SKILL_MD);
    store.saveFile('---\nname: Renamed\ndescription: edited\n---\nbody\n', 'my-skill');
    expect(store.list()[0]).toMatchObject({ dir: 'my-skill', name: 'Renamed', description: 'edited' });
    expect(store.remove('my-skill')).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('disables a skill (renames SKILL.md so the loader skips it) and re-enables it', () => {
    store.saveFile(SKILL_MD);
    store.setEnabled('my-skill', false);
    expect(existsSync(join(dir, 'skills', 'my-skill', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(dir, 'skills', 'my-skill', 'SKILL.md.disabled'))).toBe(true);
    expect(store.list()[0]).toMatchObject({ enabled: false });
    expect(store.read('my-skill')).toContain('# Steps'); // still editable while disabled

    // Editing a disabled skill keeps it disabled.
    store.saveFile('---\nname: My Skill\ndescription: still off\n---\nx\n', 'my-skill');
    expect(store.list()[0]).toMatchObject({ enabled: false });

    store.setEnabled('my-skill', true);
    expect(existsSync(join(dir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(store.list()[0]).toMatchObject({ enabled: true });
  });

  it('rejects a SKILL.md without name/description', () => {
    expect(() => store.saveFile('# no frontmatter')).toThrow(/frontmatter name/);
  });
});

describe('zip bundles', () => {
  it('unpacks a folder bundle (SKILL.md + assets) into the skills dir', () => {
    const zip = buildZip([
      { name: 'pkg/SKILL.md', data: Buffer.from('---\nname: Zipped\ndescription: from zip\n---\nhi'), method: 8 },
      { name: 'pkg/scripts/run.py', data: Buffer.from('print(1)') },
    ]);
    const summary = store.addZip(zip);
    expect(summary).toMatchObject({ dir: 'zipped', name: 'Zipped' });
    expect(existsSync(join(dir, 'skills', 'zipped', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dir, 'skills', 'zipped', 'scripts', 'run.py'), 'utf8')).toBe('print(1)');
    expect(store.list()[0]!.name).toBe('Zipped');
  });

  it('unpacks a root bundle (SKILL.md at the zip root)', () => {
    const zip = buildZip([{ name: 'SKILL.md', data: Buffer.from('---\nname: Root\ndescription: d\n---\nx') }]);
    expect(store.addZip(zip)).toMatchObject({ dir: 'root', name: 'Root' });
    expect(existsSync(join(dir, 'skills', 'root', 'SKILL.md'))).toBe(true);
  });

  it('rejects a zip without SKILL.md', () => {
    expect(() => store.addZip(buildZip([{ name: 'readme.txt', data: Buffer.from('x') }]))).toThrow(/SKILL\.md/);
  });
});
