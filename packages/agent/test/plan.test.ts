import { describe, it, expect, vi } from 'vitest';
import { PlanController, type PlanEmitter, type PlanProposal } from '../src/runtime/plan.js';

function proposal(over: Partial<PlanProposal> = {}): PlanProposal {
  return { runId: 'r1', agentId: 'orch', planId: 'p1', plan: 'do the thing', ...over };
}

describe('PlanController', () => {
  it('emits on propose and resolves with the decision', async () => {
    const emit = vi.fn();
    const emitter: PlanEmitter = { emitPlanProposed: emit };
    const ctrl = new PlanController(emitter);

    const p = ctrl.propose(proposal());
    expect(emit).toHaveBeenCalledOnce();
    expect(ctrl.resolve('p1', 'approve')).toBe(true);
    expect(await p).toEqual({ decision: 'approve', plan: 'do the thing', targetMode: undefined });
  });

  it('echoes an edited plan on approve', async () => {
    const ctrl = new PlanController({ emitPlanProposed: () => {} });
    const p = ctrl.propose(proposal());
    ctrl.resolve('p1', 'edit', { editedPlan: 'revised', targetMode: 'auto' });
    expect(await p).toEqual({ decision: 'approve', plan: 'revised', targetMode: 'auto' });
  });

  it('cancelAll() rejects every in-flight proposal', async () => {
    const ctrl = new PlanController({ emitPlanProposed: () => {} });
    const p = ctrl.propose(proposal());
    ctrl.cancelAll();
    expect(await p).toEqual({ decision: 'reject' });
    expect(ctrl.resolve('p1', 'approve')).toBe(false);
  });

  it('settles as reject when the run aborts (report run not covered by cancelAll)', async () => {
    const emit = vi.fn();
    const ctrl = new PlanController({ emitPlanProposed: emit });
    const ac = new AbortController();
    const p = ctrl.propose(proposal(), ac.signal);
    expect(emit).toHaveBeenCalledOnce();
    ac.abort();
    expect(await p).toEqual({ decision: 'reject' });
    expect(ctrl.resolve('p1', 'approve')).toBe(false);
  });

  it('does not emit and rejects if the signal is already aborted', async () => {
    const emit = vi.fn();
    const ctrl = new PlanController({ emitPlanProposed: emit });
    const ac = new AbortController();
    ac.abort();
    expect(await ctrl.propose(proposal(), ac.signal)).toEqual({ decision: 'reject' });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a normal resolve removes the abort listener (no leak)', async () => {
    const ctrl = new PlanController({ emitPlanProposed: () => {} });
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const p = ctrl.propose(proposal(), ac.signal);
    ctrl.resolve('p1', 'keep');
    await p;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
