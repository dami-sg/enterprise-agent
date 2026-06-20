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
});
