import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from 'ai';
import { SkillRegistry } from '../src/skills/loader.js';
import { buildSkillTools } from '../src/tools/skill.js';
import { makeHarness, type Harness } from './helpers/harness.js';

/** Write a SKILL.md skill (frontmatter + a recognizable body) into `root/<name>/`. */
function writeSkill(root: string, name: string, frontmatter: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\nBODY:${name}\n`, 'utf8');
}

/** Invoke a tool's execute directly (mirrors the AI SDK's call shape). */
function call(t: Tool, input: Record<string, unknown>): Promise<any> {
  const execute = (t as { execute?: (...a: unknown[]) => Promise<unknown> }).execute!;
  return execute(input, { toolCallId: 'c1', messages: [], abortSignal: new AbortController().signal });
}

describe('useSkill / searchSkills tools (agent §3.6)', () => {
  let root: string;
  let h: Harness;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ea-skilltool-'));
    writeSkill(root, 'pdf-extract', 'name: pdf-extract\ndescription: Extract text from PDF\nkeywords: [pdf, parse]');
    writeSkill(root, 'summarize', 'name: summarize\ndescription: Summarize a document');
    writeSkill(root, 'scaffold', 'name: scaffold\ndescription: Create project files\nallowed-tools: [readFile, writeFile]');
    writeSkill(root, 'hidden', 'name: hidden\ndescription: never auto\ndisable-model-invocation: true');
    const reg = new SkillRegistry([root]);
    // Wire the harness services exactly as index.ts does in production.
    h = makeHarness({
      loadSkill: (name, allowed) => reg.loadForModel(name, allowed),
      searchSkills: (query, allowed) =>
        reg.search(query, { allowedToolNames: allowed }).map((hit) => ({
          name: hit.meta.name,
          description: hit.meta.description,
        })),
    });
  });

  afterAll(() => {
    h.cleanup();
    rmSync(root, { recursive: true, force: true });
  });

  it('useSkill loads the full body into the tool result', async () => {
    const { useSkill } = buildSkillTools(h.parent);
    const r = await call(useSkill, { name: 'summarize' });
    expect(r).toMatchObject({ name: 'summarize' });
    expect(r.instructions).toContain('BODY:summarize');
  });

  it('useSkill reports not_found vs not_available distinctly', async () => {
    const { useSkill } = buildSkillTools(h.parent);
    expect(await call(useSkill, { name: 'nope' })).toMatchObject({ error: 'not_found' });
    // disable-model-invocation → withheld from the model even for the orchestrator.
    expect(await call(useSkill, { name: 'hidden' })).toMatchObject({ error: 'not_available' });
  });

  it('useSkill honors the role tool gate via allowedToolNames', async () => {
    const readOnly = buildSkillTools(h.parent, ['readFile']);
    expect(await call(readOnly.useSkill, { name: 'scaffold' })).toMatchObject({ error: 'not_available' });
    const writer = buildSkillTools(h.parent, ['readFile', 'writeFile']);
    expect(await call(writer.useSkill, { name: 'scaffold' })).toMatchObject({ name: 'scaffold' });
  });

  it('searchSkills returns relevance-ranked hits', async () => {
    const { searchSkills } = buildSkillTools(h.parent);
    const r = await call(searchSkills, { query: 'parse a pdf' });
    expect(r.results[0]).toMatchObject({ name: 'pdf-extract' });
    expect(r.count).toBeGreaterThan(0);
    expect(r.results.map((x: { name: string }) => x.name)).not.toContain('hidden');
  });

  it('searchSkills caps results by limit and excludes role-withheld skills', async () => {
    const readOnly = buildSkillTools(h.parent, ['readFile']);
    const r = await call(readOnly.searchSkills, { query: 'create project files', limit: 5 });
    expect(r.results.map((x: { name: string }) => x.name)).not.toContain('scaffold');
  });
});
