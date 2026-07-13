/**
 * Interactive question controller — the elicitation twin of ApprovalController
 * (approval/approval.ts). Where approval is the kernel *intercepting* a
 * high-risk call, this is the model *initiating* a round-trip via the
 * `askUserQuestion` tool. Same bridge:
 *   1. ask() emits `user-question-required` and suspends on a Promise.
 *   2. the host renders the options; the user picks.
 *   3. host calls resolve(questionId, answers); the Promise settles and the
 *      suspended tool returns the selection to the model.
 * On abort, cancelAll() settles any in-flight questions so the run can unwind.
 */
import type { UserQuestion, UserQuestionAnswer } from '@dami-sg/agent-contract';

export interface QuestionRequest {
  runId: string;
  agentId: string;
  parentAgentId?: string;
  /** Correlation id for the answer; the asking tool's toolCallId. */
  questionId: string;
  questions: UserQuestion[];
}

export type QuestionOutcome =
  | { cancelled: false; answers: UserQuestionAnswer[] }
  | { cancelled: true };

export interface QuestionEmitter {
  emitQuestionRequired(req: QuestionRequest): void;
}

export class QuestionController {
  private pending = new Map<string, { resolve: (outcome: QuestionOutcome) => void; dispose: () => void }>();

  constructor(private readonly emitter: QuestionEmitter) {}

  /**
   * Ask the user; resolves once the host delivers an answer (or a dismissal).
   *
   * `abortSignal` makes the wait abort-aware, mirroring `ApprovalController.gate`:
   * a report run (or any run whose id isn't the session's `activeRunId`) is never
   * reached by `cancelAll()`, so without listening here an aborted run suspended
   * on a question would hang forever. On abort we settle as cancelled so the run
   * unwinds.
   */
  async ask(req: QuestionRequest, abortSignal?: AbortSignal): Promise<QuestionOutcome> {
    if (abortSignal?.aborted) return { cancelled: true };
    this.emitter.emitQuestionRequired(req);
    return new Promise<QuestionOutcome>((resolve) => {
      const onAbort = (): void => {
        if (this.pending.delete(req.questionId)) resolve({ cancelled: true });
      };
      abortSignal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(req.questionId, {
        resolve,
        dispose: () => abortSignal?.removeEventListener('abort', onAbort),
      });
    });
  }

  /** Host → module: deliver the selection. `null` = the user dismissed it. */
  resolve(questionId: string, answers: UserQuestionAnswer[] | null): boolean {
    const p = this.pending.get(questionId);
    if (!p) return false;
    this.pending.delete(questionId);
    p.dispose();
    p.resolve(answers === null ? { cancelled: true } : { cancelled: false, answers });
    return true;
  }

  /** Cancel any in-flight questions (e.g. on abort), unblocking the run. */
  cancelAll(): void {
    for (const [, p] of this.pending) {
      p.dispose();
      p.resolve({ cancelled: true });
    }
    this.pending.clear();
  }
}
