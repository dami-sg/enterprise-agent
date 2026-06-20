import { describe, it, expect } from 'vitest';
import { buildDateTool } from '../src/tools/date.js';
import type { RunContext } from '../src/runtime/context.js';

const ctx = {} as unknown as RunContext;

type ToolWithExecute = {
  execute: (args: unknown, opts: unknown) => Promise<unknown>;
};

const run = (input: unknown) =>
  (buildDateTool(ctx).getCurrentTime as unknown as ToolWithExecute).execute(input, {});

describe('Built-in clock (getCurrentTime, agent §3)', () => {
  it('returns the current instant with timezone, weekday and a formatted string', async () => {
    const before = Date.now();
    const res = (await run({})) as {
      iso: string;
      unixSeconds: number;
      timeZone: string;
      weekday: string;
      formatted: string;
    };
    const after = Date.now();

    // iso is a real, parseable UTC instant within the call window.
    const t = Date.parse(res.iso);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);

    expect(res.unixSeconds).toBe(Math.floor(t / 1000));
    expect(res.timeZone).toBeTruthy();
    expect(res.formatted).toContain(String(new Date(t).getUTCFullYear()).slice(0, 2)); // "20.."
    expect(res.weekday).toMatch(/day$/); // English weekday name
  });

  it('honors an explicit IANA timezone', async () => {
    const res = (await run({ timeZone: 'Asia/Shanghai' })) as { timeZone: string; formatted: string };
    expect(res.timeZone).toBe('Asia/Shanghai');
    expect(res.formatted.length).toBeGreaterThan(0);
  });

  it('returns an error for an invalid timezone instead of throwing', async () => {
    const res = (await run({ timeZone: 'Not/AZone' })) as { error?: string };
    expect(res.error).toBeDefined();
    expect(res.error).toContain('Not/AZone');
  });
});
