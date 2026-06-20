import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRegistry } from '../src/skills/loader.js';

/** Write a SKILL.md skill into `root/<name>/`. */
function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nbody for ${name}\n`, 'utf8');
}

describe('Skill catalog filtering for sub-agents (agent §2.3 / §3.6)', () => {
  let root: string;
  let reg: SkillRegistry;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ea-skills-'));
    // No tool restriction → available to anyone.
    writeSkill(root, 'summarize', 'name: summarize\ndescription: Summarize text');
    // Needs only read tools → a read-only researcher can carry it out.
    writeSkill(root, 'audit-readonly', 'name: audit-readonly\ndescription: Read & report\nallowed-tools: [readFile, search]');
    // Needs writeFile → only a writer/coder.
    writeSkill(root, 'scaffold', 'name: scaffold\ndescription: Create files\nallowed-tools: [readFile, writeFile]');
    // Hidden from model invocation entirely.
    writeSkill(root, 'secret', 'name: secret\ndescription: hidden\ndisable-model-invocation: true');
    reg = new SkillRegistry([root]);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('full catalog (orchestrator) lists every model-invocable skill', () => {
    const cat = reg.catalog();
    expect(cat).toContain('summarize');
    expect(cat).toContain('audit-readonly');
    expect(cat).toContain('scaffold');
    expect(cat).not.toContain('secret'); // disable-model-invocation
  });

  it('a read-only role only sees skills it can carry out', () => {
    const cat = reg.catalog(['readFile', 'listDir', 'search', 'httpFetch']);
    expect(cat).toContain('summarize'); // no tool requirement
    expect(cat).toContain('audit-readonly'); // readFile+search ⊆ tools
    expect(cat).not.toContain('scaffold'); // needs writeFile, withheld
  });

  it('a write-capable role additionally sees write skills', () => {
    const cat = reg.catalog(['readFile', 'listDir', 'search', 'writeFile', 'applyPatch']);
    expect(cat).toContain('scaffold');
    expect(cat).toContain('audit-readonly');
  });

  it('empty tool set → only unrestricted skills', () => {
    const cat = reg.catalog([]);
    expect(cat).toContain('summarize');
    expect(cat).not.toContain('audit-readonly');
    expect(cat).not.toContain('scaffold');
  });
});
