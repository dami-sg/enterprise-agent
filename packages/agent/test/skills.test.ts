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

describe('Skill search & progressive disclosure (agent §3.6)', () => {
  let root: string;
  let reg: SkillRegistry;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ea-skillsearch-'));
    writeSkill(root, 'pdf-extract', 'name: pdf-extract\ndescription: Extract text and tables from PDF files\nkeywords: [pdf, document, parse]');
    writeSkill(root, 'csv-clean', 'name: csv-clean\ndescription: Clean and normalize messy CSV spreadsheets');
    writeSkill(root, 'summarize', 'name: summarize\ndescription: Summarize a long document into bullet points');
    writeSkill(root, 'scaffold', 'name: scaffold\ndescription: Create project files\nallowed-tools: [readFile, writeFile]');
    writeSkill(root, 'hidden', 'name: hidden\ndescription: pdf secret\ndisable-model-invocation: true');
    reg = new SkillRegistry([root]);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('ranks by relevance, name/keyword beating a mere description mention', () => {
    const hits = reg.search('pdf');
    expect(hits[0]!.meta.name).toBe('pdf-extract'); // name + keyword hit ranks first
    expect(hits.map((h) => h.meta.name)).not.toContain('hidden'); // disable-model-invocation
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it('recalls via keywords frontmatter even when the word is absent from name/description', () => {
    const hits = reg.search('parse document');
    expect(hits[0]!.meta.name).toBe('pdf-extract');
  });

  it('empty query → no hits; unmatched query → no hits', () => {
    expect(reg.search('')).toHaveLength(0);
    expect(reg.search('kubernetes helm chart')).toHaveLength(0);
  });

  it('search respects the role tool gate (allowedToolNames)', () => {
    const readOnly = reg.search('create project files', { allowedToolNames: ['readFile'] });
    expect(readOnly.map((h) => h.meta.name)).not.toContain('scaffold'); // needs writeFile
    const writer = reg.search('create project files', { allowedToolNames: ['readFile', 'writeFile'] });
    expect(writer.map((h) => h.meta.name)).toContain('scaffold');
  });

  it('catalog: at/below threshold lists every skill in full', () => {
    const cat = reg.catalog(); // 4 visible ≤ default threshold
    expect(cat).toContain('useSkill');
    expect(cat).toContain('pdf-extract');
    expect(cat).toContain('summarize');
    expect(cat).not.toContain('hidden');
  });

  it('catalog: above threshold switches to search mode with relevance prefetch', () => {
    const small = new SkillRegistry([root], { searchThreshold: 2 });
    const withQuery = small.catalog(undefined, 'extract a pdf');
    expect(withQuery).toContain('searchSkills');
    expect(withQuery).toContain('too many to list in full');
    expect(withQuery).toContain('Most relevant');
    expect(withQuery).toContain('pdf-extract'); // prefetched top hit
    expect(withQuery).not.toContain('csv-clean'); // irrelevant to the query

    // No query → just the search instruction, no prefetch block.
    const noQuery = small.catalog();
    expect(noQuery).toContain('searchSkills');
    expect(noQuery).not.toContain('Most relevant');
  });

  it('loadForModel enforces invocation policy', () => {
    expect(reg.loadForModel('summarize')).toMatchObject({ name: 'summarize' });
    expect(reg.loadForModel('nope')).toEqual({ error: 'not_found' });
    expect(reg.loadForModel('hidden')).toEqual({ error: 'not_available' }); // disable-model-invocation
    // scaffold needs writeFile → withheld from a read-only role.
    expect(reg.loadForModel('scaffold', ['readFile'])).toEqual({ error: 'not_available' });
    expect(reg.loadForModel('scaffold', ['readFile', 'writeFile'])).toMatchObject({ name: 'scaffold' });
  });
});
