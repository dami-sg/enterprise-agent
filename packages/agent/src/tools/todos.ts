/**
 * Built-in task planning (agent §3.7): `updateTodos` maintains the Work's
 * structured plan. No side effects, no approval. Full replacement each call;
 * at most one `in_progress`. Work-scoped — sub-agents don't get this tool.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { Todo } from '@enterprise-agent/agent-contract';
import type { RunContext } from '../runtime/context.js';

function tally(todos: Todo[]) {
  return {
    pending: todos.filter((t) => t.status === 'pending').length,
    in_progress: todos.filter((t) => t.status === 'in_progress').length,
    completed: todos.filter((t) => t.status === 'completed').length,
    total: todos.length,
  };
}

export function buildTodoTool(ctx: RunContext) {
  const updateTodos = tool({
    description:
      'Maintain this task\'s structured plan (todo list). At the start of a multi-step task break the goal into todos; mark one in_progress and completed as you go. Submit the FULL list each call (full replacement).',
    inputSchema: z.object({
      todos: z.array(
        z.object({
          id: z.string(),
          content: z.string().describe('Imperative todo text.'),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      ),
    }),
    execute: async ({ todos }) => {
      // Enforce single-focus: keep only the first in_progress (agent §3.7).
      let seenActive = false;
      const normalized: Todo[] = todos.map((t) => {
        if (t.status === 'in_progress') {
          if (seenActive) return { ...t, status: 'pending' as const };
          seenActive = true;
        }
        return t;
      });
      ctx.shared.setTodos(normalized);
      ctx.shared.emit({ kind: 'todo-update', workId: ctx.shared.workId, todos: normalized });
      return { ok: true, counts: tally(normalized) };
    },
  });

  return { updateTodos };
}
