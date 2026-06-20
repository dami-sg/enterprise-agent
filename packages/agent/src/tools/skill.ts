/**
 * Skill tools (agent §3.6). The model-facing half of progressive disclosure:
 *  - `searchSkills` — rank available skills by relevance to a query (used when
 *    the catalog is summarized as a count rather than listed in full).
 *  - `useSkill` — load a named skill's full `SKILL.md` body into context as the
 *    tool result (progressive disclosure level 2). Read-only, ungated.
 *
 * `allowedToolNames` binds the visibility window: omit it for the orchestrator
 * (every local tool), or pass a sub-agent's role tool names so search/load only
 * cover skills it can actually carry out (§2.3 / §3.4).
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../runtime/context.js';

export function buildSkillTools(ctx: RunContext, allowedToolNames?: string[]) {
  const useSkill = tool({
    description:
      "Load a skill's full instructions into context. Pass the `name` of a skill from the available-skills list or from searchSkills; the returned instructions are authoritative for that skill — follow them. Read-only, no approval needed. Errors with not_found (no such skill) or not_available (the skill is not invocable in your current role/tool set).",
    inputSchema: z.object({ name: z.string().describe('The skill name to load.') }),
    execute: async ({ name }) => {
      const r = ctx.shared.loadSkill(name, allowedToolNames);
      if ('error' in r) {
        return r.error === 'not_found'
          ? { error: 'not_found', name, note: 'No such skill. Call searchSkills to discover available skills.' }
          : { error: 'not_available', name, note: 'This skill is not invocable in your current role/tool set.' };
      }
      return { name: r.name, instructions: r.body };
    },
  });

  const searchSkills = tool({
    description:
      'Search the available skills by relevance to a query (a short task description or keywords). Returns the best-matching skills with descriptions; load one with useSkill. Use this when the available-skills list is summarized as a count, or whenever you are unsure which skill fits the task.',
    inputSchema: z.object({
      query: z.string().describe('Task description or keywords to match skills against.'),
      limit: z.number().int().positive().max(20).optional().describe('Max results (default 8).'),
    }),
    execute: async ({ query, limit }) => {
      const results = ctx.shared.searchSkills(query, allowedToolNames).slice(0, limit ?? 8);
      return { query, count: results.length, results };
    },
  });

  return { useSkill, searchSkills };
}
