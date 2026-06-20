/**
 * The runCommand/runScript cwd boundary admits skill dirs (agent §3.6/§4), so a
 * skill's bundled scripts run from where they live — while a foreign cwd is
 * still rejected and writes stay confined to the workspace.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.js';
import { buildExecTools } from '../src/tools/exec.js';

const call = (tool: unknown, input: unknown, toolCallId = 'tc-1') =>
  (tool as { execute: (i: unknown, o: { toolCallId: string }) => Promise<any> }).execute(input, { toolCallId });

describe('runCommand cwd boundary includes skill roots (agent §3.6/§4)', () => {
  it('runs from a skill dir but rejects a cwd outside every root', async () => {
    const skillRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ea-skills-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ea-out-')));
    const h = makeHarness({ skillRoots: [skillRoot], autoApprove: 'once' });
    const exec = buildExecTools(h.parent);

    // cwd inside the skill root → allowed; the process actually runs there.
    const ok = await call(exec.runCommand, {
      command: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd: skillRoot,
    });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toBe(skillRoot);
    expect('error' in ok).toBe(false);

    // cwd outside both the workspace and the skill roots → boundary error,
    // rejected before the approval gate.
    const bad = await call(exec.runCommand, { command: 'node', args: ['-e', '0'], cwd: outside });
    expect(bad).toMatchObject({ error: 'cwd_outside_boundary', cwd: outside });

    h.cleanup();
  });

  it('without skill roots, a non-workspace cwd is still rejected', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ea-out2-')));
    const h = makeHarness({ autoApprove: 'once' });
    const exec = buildExecTools(h.parent);
    expect(await call(exec.runCommand, { command: 'node', args: ['-e', '0'], cwd: outside })).toMatchObject({
      error: 'cwd_outside_boundary',
      cwd: outside,
    });
    h.cleanup();
  });
});
