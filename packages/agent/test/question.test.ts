import { describe, it, expect, vi } from 'vitest';
import {
  QuestionController,
  type QuestionEmitter,
  type QuestionRequest,
} from '../src/runtime/question.js';
import type { UserQuestion } from '@enterprise-agent/agent-contract';

const QUESTIONS: UserQuestion[] = [
  {
    question: 'Which approach?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'A', description: 'fast' },
      { label: 'B', description: 'safe' },
    ],
  },
];

function req(over: Partial<QuestionRequest> = {}): QuestionRequest {
  return { runId: 'r1', agentId: 'orch', questionId: 'q1', questions: QUESTIONS, ...over };
}

describe('Interactive question round-trip (askUserQuestion)', () => {
  it('emits on ask and resolves with the delivered answer', async () => {
    const emit = vi.fn();
    const emitter: QuestionEmitter = { emitQuestionRequired: emit };
    const ctrl = new QuestionController(emitter);

    const p = ctrl.ask(req());
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]![0].questionId).toBe('q1');

    expect(ctrl.resolve('q1', [{ selected: ['A'] }])).toBe(true);
    const outcome = await p;
    expect(outcome).toEqual({ cancelled: false, answers: [{ selected: ['A'] }] });
  });

  it('treats a null answer as a dismissal', async () => {
    const ctrl = new QuestionController({ emitQuestionRequired: () => {} });
    const p = ctrl.ask(req());
    ctrl.resolve('q1', null);
    expect(await p).toEqual({ cancelled: true });
  });

  it('resolve() for an unknown id is a no-op', () => {
    const ctrl = new QuestionController({ emitQuestionRequired: () => {} });
    expect(ctrl.resolve('nope', null)).toBe(false);
  });

  it('cancelAll() settles every in-flight question as cancelled', async () => {
    const ctrl = new QuestionController({ emitQuestionRequired: () => {} });
    const p1 = ctrl.ask(req({ questionId: 'q1' }));
    const p2 = ctrl.ask(req({ questionId: 'q2' }));
    ctrl.cancelAll();
    expect(await p1).toEqual({ cancelled: true });
    expect(await p2).toEqual({ cancelled: true });
    // table cleared — a late resolve finds nothing
    expect(ctrl.resolve('q1', [{ selected: ['A'] }])).toBe(false);
  });

  it('settles as cancelled when the run aborts (report run not covered by cancelAll)', async () => {
    const emit = vi.fn();
    const ctrl = new QuestionController({ emitQuestionRequired: emit });
    const ac = new AbortController();
    const p = ctrl.ask(req(), ac.signal);
    expect(emit).toHaveBeenCalledOnce();
    ac.abort();
    expect(await p).toEqual({ cancelled: true });
    // The pending entry was removed, so a late host answer finds nothing.
    expect(ctrl.resolve('q1', [{ selected: ['A'] }])).toBe(false);
  });

  it('does not emit and returns cancelled if the signal is already aborted', async () => {
    const emit = vi.fn();
    const ctrl = new QuestionController({ emitQuestionRequired: emit });
    const ac = new AbortController();
    ac.abort();
    expect(await ctrl.ask(req(), ac.signal)).toEqual({ cancelled: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a normal resolve after passing a signal removes the abort listener (no leak)', async () => {
    const ctrl = new QuestionController({ emitQuestionRequired: () => {} });
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
    const p = ctrl.ask(req(), ac.signal);
    ctrl.resolve('q1', [{ selected: ['A'] }]);
    await p;
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
