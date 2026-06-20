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
import type { UserQuestion, UserQuestionAnswer } from '@enterprise-agent/agent-contract';

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
  private pending = new Map<string, (outcome: QuestionOutcome) => void>();

  constructor(private readonly emitter: QuestionEmitter) {}

  /** Ask the user; resolves once the host delivers an answer (or a dismissal). */
  async ask(req: QuestionRequest): Promise<QuestionOutcome> {
    this.emitter.emitQuestionRequired(req);
    return new Promise<QuestionOutcome>((resolve) => {
      this.pending.set(req.questionId, resolve);
    });
  }

  /** Host → module: deliver the selection. `null` = the user dismissed it. */
  resolve(questionId: string, answers: UserQuestionAnswer[] | null): boolean {
    const r = this.pending.get(questionId);
    if (!r) return false;
    this.pending.delete(questionId);
    r(answers === null ? { cancelled: true } : { cancelled: false, answers });
    return true;
  }

  /** Cancel any in-flight questions (e.g. on abort), unblocking the run. */
  cancelAll(): void {
    for (const [, r] of this.pending) r({ cancelled: true });
    this.pending.clear();
  }
}
