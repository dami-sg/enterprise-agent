/**
 * `askUserQuestion` — let the orchestrator pause mid-task and ask the user to
 * choose between options it cannot resolve on its own. No side effects, no
 * approval gate; it simply round-trips a selection through the host via the
 * QuestionController (runtime/question.ts). Work-scoped like `updateTodos`:
 * sub-agents don't get it (they pursue a single delegated goal, not a dialog).
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../runtime/context.js';

export function buildAskTool(ctx: RunContext) {
  const askUserQuestion = tool({
    description:
      'Ask the user one or more multiple-choice questions and wait for their answer. This is the ONLY correct way to put a choice to the user — whenever you would otherwise write options as prose (numbered lists, "approach A/B/C?", "选 X / 选 Y", or a "questions for you" section), you must call this tool instead so the user gets a selectable prompt and your run resumes with their answer. This applies just as much to decisions you discover mid-task (e.g. after reading files you find the directory is not empty, or an action is ambiguous/risky) as to the initial ones — batch every open decision into a single call (up to 4 questions). Each question carries 2–4 options; set multiSelect to allow choosing several. Only skip the tool for things you can determine yourself or trivial confirmations — never to ask in plain text.',
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z.string().describe('The full question text.'),
            header: z.string().describe('Short label/tag for the question (≤12 chars).'),
            multiSelect: z
              .boolean()
              .default(false)
              .describe('Allow selecting more than one option.'),
            options: z
              .array(
                z.object({
                  label: z.string().describe('Concise choice text shown to the user.'),
                  description: z
                    .string()
                    .optional()
                    .describe('Optional explanation of the choice or its trade-offs.'),
                }),
              )
              .min(2)
              .max(4),
          }),
        )
        .min(1)
        .max(4),
    }),
    execute: async ({ questions }, { toolCallId }) => {
      const outcome = await ctx.shared.questions.ask({
        runId: ctx.runId,
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        questionId: toolCallId,
        questions,
      });
      if (outcome.cancelled) {
        return {
          cancelled: true,
          note: 'The user dismissed the question without selecting an answer. Proceed using your best judgement, or ask again only if you truly cannot continue.',
        };
      }
      // Pair each question with its selected labels so the model reads the
      // answer in context (questions/answers are index-aligned).
      return {
        answers: questions.map((q, i) => ({
          header: q.header,
          question: q.question,
          selected: outcome.answers[i]?.selected ?? [],
        })),
      };
    },
  });

  return { askUserQuestion };
}
