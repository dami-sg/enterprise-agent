/**
 * Extra read roots (GlobalSettings.readRoots) join the same "read + run, never
 * write" boundary tier as skill dirs (agent §4): a configured read root — e.g.
 * the config dir — is a valid exec `cwd`, but it is not the workspace, so writes
 * still confine to `rootPaths` and a foreign cwd is still rejected.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.js';
import { buildExecTools } from '../src/tools/exec.js';

const call = (tool: unknown, input: unknown, toolCallId = 'tc-1') =>
  (tool as { execute: (i: unknown, o: { toolCallId: string }) => Promise<any> }).execute(input, { toolCallId });

describe('runCommand cwd boundary includes extra read roots (agent §4)', () => {
  it('runs from a configured read root but rejects a cwd outside every root', async () => {
    const readRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ea-readroot-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ea-out-')));
    const h = makeHarness({ readRoots: [readRoot], autoApprove: 'once' });
    const exec = buildExecTools(h.parent);

    // cwd inside the read root → allowed; the process actually runs there.
    const ok = await call(exec.runCommand, {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: readRoot,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(readRoot);
    expect('error' in ok).toBe(false);

    // cwd outside the workspace and the read roots → boundary error.
    const bad = await call(exec.runCommand, { command: 'node', args: ['-e', '0'], cwd: outside });
    expect(bad).toMatchObject({ error: 'cwd_outside_boundary', cwd: outside });

    h.cleanup();
  });

  it('a read root is exposed on shared.readRoots, distinct from the writable rootPaths', () => {
    const readRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ea-readroot2-')));
    const h = makeHarness({ readRoots: [readRoot] });
    expect(h.parent.shared.readRoots).toContain(readRoot);
    // The read root never joins the writable boundary.
    expect(h.parent.shared.rootPaths).not.toContain(readRoot);
    h.cleanup();
  });
});
