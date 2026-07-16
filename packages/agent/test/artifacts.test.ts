import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStreamEvent, Artifact } from '@dami-sg/agent-contract';
import { buildArtifactTools } from '../src/tools/artifacts.js';
import type { RunContext } from '../src/runtime/context.js';

function ctxWith(root: string) {
  const store: Artifact[] = [];
  const events: AgentStreamEvent[] = [];
  const ctx = {
    runId: 'r1',
    shared: {
      sessionId: 's1',
      rootPaths: [root],
      addArtifact: (a: Artifact) => store.push(a),
      listArtifacts: () => [...store],
      emit: (e: AgentStreamEvent) => events.push(e),
    },
  } as unknown as RunContext;
  return { ctx, store, events };
}

// biome-ignore lint/suspicious/noExplicitAny: exercising the AI SDK tool.execute directly
const run = (t: any, args: any) => t.execute(args, {} as any);

describe('artifact tools (agent §artifacts)', () => {
  it('registers a written file, emits artifact-created, and lists/finds it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'art-'));
    writeFileSync(join(root, 'report.md'), '# hello');
    const { ctx, store, events } = ctxWith(root);
    const tools = buildArtifactTools(ctx);

    const created = await run(tools.createArtifact, {
      name: 'Report',
      path: 'report.md',
      kind: 'document',
      mimeType: 'text/markdown',
    });
    expect(created).toMatchObject({ ok: true, name: 'Report', kind: 'document', path: 'report.md' });
    expect(store).toHaveLength(1);
    expect(store[0]!.size).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'artifact-created')).toBe(true);

    const listed = (await run(tools.listArtifacts, {})) as { count: number; artifacts: Array<{ name: string }> };
    expect(listed.count).toBe(1);
    expect(listed.artifacts[0]!.name).toBe('Report');

    // Substring match ("repo" ⊂ "report").
    expect(((await run(tools.findArtifact, { query: 'repo' })) as { count: number }).count).toBe(1);
    expect(((await run(tools.findArtifact, { query: 'zzz' })) as { count: number }).count).toBe(0);
  });

  it('rejects a path outside the working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'art-'));
    const { ctx, store } = ctxWith(root);
    const tools = buildArtifactTools(ctx);
    const res = (await run(tools.createArtifact, { name: 'x', path: '../escape.txt', kind: 'other' })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(false);
    expect(store).toHaveLength(0);
  });

  it('rejects a non-existent file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'art-'));
    const { ctx } = ctxWith(root);
    const tools = buildArtifactTools(ctx);
    const res = (await run(tools.createArtifact, { name: 'x', path: 'nope.txt', kind: 'other' })) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});
