/**
 * Plan-mode lockdown (agent §3.8.2). `enforceModeForTier` is the shared guard
 * that both local mutating tools and MCP tools call before their approval gate —
 * the MCP path passes its server's `riskTier` so a mutating MCP tool is blocked
 * in plan mode exactly like a local writeFile/runCommand.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeHarness, type Harness } from './helpers/harness.js';
import { enforceModeForTier } from '../src/tools/mode.js';

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

const check = { toolName: 'mcp__fs__write', toolCallId: 't1', input: {} };

describe('enforceModeForTier', () => {
  it('blocks write/exec tiers in plan mode', () => {
    harness = makeHarness({ executionMode: 'plan' });
    for (const tier of ['write', 'exec'] as const) {
      const res = enforceModeForTier(harness.parent, tier, check);
      expect(res.blocked).toBe(true);
      if (res.blocked) expect((res.result as { error: string }).error).toBe('plan_mode');
    }
  });

  it('treats an unknown/undefined MCP risk tier as exec (fail-closed) in plan mode', () => {
    harness = makeHarness({ executionMode: 'plan' });
    const res = enforceModeForTier(harness.parent, undefined, check);
    expect(res.blocked).toBe(true);
  });

  it('allows readonly tier in plan mode', () => {
    harness = makeHarness({ executionMode: 'plan' });
    expect(enforceModeForTier(harness.parent, 'readonly', check).blocked).toBe(false);
  });

  it('gates network tier on plan.allowNetwork', () => {
    harness = makeHarness({ executionMode: 'plan', planAllowNetwork: false });
    expect(enforceModeForTier(harness.parent, 'network', check).blocked).toBe(true);
    harness.cleanup();
    harness = makeHarness({ executionMode: 'plan', planAllowNetwork: true });
    expect(enforceModeForTier(harness.parent, 'network', check).blocked).toBe(false);
  });

  it('never blocks outside plan mode', () => {
    harness = makeHarness({ executionMode: 'ask' });
    for (const tier of ['readonly', 'write', 'exec', 'network'] as const) {
      expect(enforceModeForTier(harness.parent, tier, check).blocked).toBe(false);
    }
  });
});
