/**
 * `full` execution mode at the gate (agent §3.8.5). In `full` mode the gate must
 * NOT call the classifier: safe calls run immediately (audited as `full`), while
 * the un-exemptible high-risk set falls through to the human approval gate. In
 * `auto` mode the classifier path is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.js';
import { buildExecTools } from '../src/tools/exec.js';
import { buildFileTools } from '../src/tools/file.js';
import type { AutoClassifierResult } from '../src/runtime/auto-classifier.js';

const run = (tool: unknown, input: unknown, toolCallId = 'tc-1') =>
  (tool as { execute: (i: unknown, o: { toolCallId: string }) => Promise<any> }).execute(input, { toolCallId });

const allow = async (): Promise<AutoClassifierResult> => ({ verdict: 'allow', reason: 'spy-allow' });

describe('gate: full mode (agent §3.8.5)', () => {
  it('runs a safe command WITHOUT calling the classifier, audited as full', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'full', auto: { classify } });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'echo', args: ['hi'] });

    expect(classify).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('error');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'auto-classified', verdict: 'allow', reason: 'full' }),
    );
    expect(h.gateRequests).toHaveLength(0); // never reached the human gate
    h.cleanup();
  });

  it('routes a system-level destructive delete to the human gate, NOT the classifier', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'full', auto: { classify }, autoApprove: 'reject' });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'rm', args: ['-rf', '/etc/nginx'] });

    expect(classify).not.toHaveBeenCalled(); // full mode skips the classifier entirely
    expect(h.gateRequests).toHaveLength(1); // fell through to the human approval gate
    expect(h.gateRequests[0]).toMatchObject({ toolName: 'runCommand', grantKey: 'rm' });
    expect(out).toMatchObject({ error: 'rejected' }); // we rejected at the gate
    h.cleanup();
  });

  it('runs an interpreter (bash -c) UNPROMPTED in full mode (boundary off)', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'full', auto: { classify }, autoApprove: 'reject' });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'bash', args: ['-c', 'echo hi'] });

    expect(classify).not.toHaveBeenCalled();
    expect(h.gateRequests).toHaveLength(0); // bash is no longer gated in full mode
    expect(out).not.toHaveProperty('error');
    h.cleanup();
  });

  it('routes privilege escalation (sudo) to the human gate', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'full', auto: { classify }, autoApprove: 'reject' });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'sudo', args: ['apt', 'install', 'x'] });

    expect(classify).not.toHaveBeenCalled();
    expect(h.gateRequests).toHaveLength(1);
    expect(out).toMatchObject({ error: 'rejected' });
    h.cleanup();
  });

  it('regression: in auto mode, a safe command still goes through the classifier', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'auto', auto: { classify } });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'echo', args: ['hi'] });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveProperty('error');
    h.cleanup();
  });
});

describe('full mode disables the workspace boundary guardrail (agent §4)', () => {
  it('writeFile may write OUTSIDE the workspace roots in full mode', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ea-outside-'));
    const target = join(outside, 'escaped.txt');
    const h = makeHarness({ executionMode: 'full' });
    const file = buildFileTools(h.parent);

    const out = await run(file.writeFile, { path: target, content: 'hi' });

    expect(out).not.toHaveProperty('error'); // no out_of_boundary
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hi');
    h.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  it('the SAME out-of-boundary write is blocked in ask mode', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ea-outside-'));
    const target = join(outside, 'escaped.txt');
    const h = makeHarness({ executionMode: 'ask', autoApprove: 'once' });
    const file = buildFileTools(h.parent);

    const out = await run(file.writeFile, { path: target, content: 'hi' });

    expect(out).toMatchObject({ error: 'out_of_boundary' });
    expect(existsSync(target)).toBe(false);
    h.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });
});
