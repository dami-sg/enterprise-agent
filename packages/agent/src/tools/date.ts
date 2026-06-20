/**
 * Built-in clock (agent §3): `getCurrentTime` returns the host's current local
 * date/time. Read-only, no side effects, no approval — available to the
 * orchestrator and every sub-agent role. The model's training data has a cutoff,
 * so it must call this instead of guessing "now".
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { RunContext } from '../runtime/context.js';

export interface CurrentTime {
  /** Absolute instant, UTC ISO-8601 (e.g. `2026-06-20T08:43:00.000Z`). */
  iso: string;
  /** Whole seconds since the Unix epoch. */
  unixSeconds: number;
  /** Resolved IANA timezone (the requested one, or the host default). */
  timeZone: string;
  /** Day of week in the resolved zone (e.g. `Saturday`). */
  weekday: string;
  /** Human-readable local date+time with offset, in the resolved zone. */
  formatted: string;
}

export function buildDateTool(_ctx: RunContext) {
  const getCurrentTime = tool({
    description:
      'Get the current local date and time. Call this whenever you need to know "now" — the current date, time, day of week, or timezone (e.g. for greetings, scheduling, age/duration math, or anything time-sensitive). Your knowledge has a training cutoff, so never guess the date — always call this tool.',
    inputSchema: z.object({
      timeZone: z
        .string()
        .optional()
        .describe(
          'Optional IANA timezone such as "Asia/Shanghai" or "America/New_York". Omit to use the host\'s local timezone.',
        ),
    }),
    execute: async ({ timeZone }): Promise<CurrentTime | { error: string }> => {
      const now = new Date();
      const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        const formatted = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          dateStyle: 'full',
          timeStyle: 'long',
        }).format(now);
        const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
        return {
          iso: now.toISOString(),
          unixSeconds: Math.floor(now.getTime() / 1000),
          timeZone: tz,
          weekday,
          formatted,
        };
      } catch (e) {
        return { error: `Invalid timeZone "${tz}": ${String(e)}` };
      }
    },
  });

  return { getCurrentTime };
}
