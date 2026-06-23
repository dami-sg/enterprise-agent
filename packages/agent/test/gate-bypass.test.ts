/**
 * Auto-mode bypass at the gate (agent §3.8.5). With `auto.bypass` on, the gate
 * must NOT call the classifier: safe calls run immediately (audited as
 * `auto-bypass`), while the un-exemptible high-risk set falls through to the
 * human approval gate. With bypass off, the classifier path is unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeHarness } from './helpers/harness.js';
import { buildExecTools } from '../src/tools/exec.js';
import type { AutoClassifierResult } from '../src/runtime/auto-classifier.js';

const run = (tool: unknown, input: unknown, toolCallId = 'tc-1') =>
  (tool as { execute: (i: unknown, o: { toolCallId: string }) => Promise<any> }).execute(input, { toolCallId });

const allow = async (): Promise<AutoClassifierResult> => ({ verdict: 'allow', reason: 'spy-allow' });

describe('gate: auto bypass (agent §3.8.5)', () => {
  it('runs a safe command WITHOUT calling the classifier, audited as auto-bypass', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'auto', auto: { bypass: true, classify } });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'echo', args: ['hi'] });

    expect(classify).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('error');
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'auto-classified', verdict: 'allow', reason: 'auto-bypass' }),
    );
    expect(h.gateRequests).toHaveLength(0); // never reached the human gate
    h.cleanup();
  });

  it('routes a system-level destructive delete to the human gate, NOT the classifier', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'auto', auto: { bypass: true, classify }, autoApprove: 'reject' });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'rm', args: ['-rf', '/etc/nginx'] });

    expect(classify).not.toHaveBeenCalled(); // bypass skips the classifier entirely
    expect(h.gateRequests).toHaveLength(1); // fell through to the human approval gate
    expect(h.gateRequests[0]).toMatchObject({ toolName: 'runCommand', grantKey: 'rm' });
    expect(out).toMatchObject({ error: 'rejected' }); // we rejected at the gate
    h.cleanup();
  });

  it('treats an interpreter (bash -c) as high-risk under bypass → human gate', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'auto', auto: { bypass: true, classify }, autoApprove: 'reject' });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'bash', args: ['-c', 'echo hi'] });

    expect(classify).not.toHaveBeenCalled();
    expect(h.gateRequests).toHaveLength(1);
    expect(out).toMatchObject({ error: 'rejected' });
    h.cleanup();
  });

  it('regression: with bypass OFF, a safe command still goes through the classifier', async () => {
    const classify = vi.fn(allow);
    const h = makeHarness({ executionMode: 'auto', auto: { bypass: false, classify } });
    const exec = buildExecTools(h.parent);

    const out = await run(exec.runCommand, { command: 'echo', args: ['hi'] });

    expect(classify).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveProperty('error');
    h.cleanup();
  });
});
