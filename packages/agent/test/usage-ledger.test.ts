import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageLedger, partitionOf } from '../src/storage/usage-ledger.js';
import type { UsageEvent } from '@dami-sg/agent-contract';

const ledgerDir = (): string => mkdtempSync(join(tmpdir(), 'ea-usage-'));

/** Build a usage event at a given local date/time. */
function ev(date: string, over: Partial<UsageEvent> = {}): UsageEvent {
  const ts = new Date(date).getTime();
  return {
    ts,
    sessionId: 's1',
    runId: 'r1',
    agentId: 'orch',
    modelRef: 'anthropic:claude-sonnet-4.5',
    provider: 'anthropic',
    category: 'orchestrator',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    cost: 0.01,
    ...over,
  };
}

describe('UsageLedger (agent §2.7)', () => {
  it('partitions by local month and aggregates a grand total', () => {
    const led = new UsageLedger(ledgerDir());
    led.append(ev('2026-06-10T09:00:00'));
    led.append(ev('2026-06-20T10:00:00', { cost: 0.02 }));
    led.append(ev('2026-05-01T10:00:00', { cost: 0.04 }));

    expect(led.partitions()).toEqual(['2026-05', '2026-06']);
    const [total] = led.query({ groupBy: [] });
    expect(total).toMatchObject({ calls: 3, inputTokens: 300, outputTokens: 150, cost: 0.07 });
  });

  it('groups by model + category and sorts by descending cost', () => {
    const led = new UsageLedger(ledgerDir());
    led.append(ev('2026-06-10T09:00:00', { modelRef: 'anthropic:claude-opus-4.1', cost: 0.5 }));
    led.append(ev('2026-06-10T09:01:00', { modelRef: 'openai:gpt-4.1', provider: 'openai', cost: 0.1 }));
    led.append(ev('2026-06-10T09:02:00', { agentId: 'system:classifier', category: 'classifier', cost: 0.02 }));

    const byModel = led.query({ groupBy: ['modelRef'] });
    expect(byModel.map((r) => r.key.modelRef)).toEqual([
      'anthropic:claude-opus-4.1', // 0.5 — highest cost first
      'openai:gpt-4.1', // 0.1
      'anthropic:claude-sonnet-4.5', // 0.02 (the classifier call)
    ]);

    const overhead = led.query({ groupBy: ['category'], filter: { category: 'classifier' } });
    expect(overhead).toHaveLength(1);
    expect(overhead[0]).toMatchObject({ key: { category: 'classifier' }, calls: 1, cost: 0.02 });
  });

  it('buckets by day and respects the [from, to) range', () => {
    const led = new UsageLedger(ledgerDir());
    led.append(ev('2026-06-10T08:00:00'));
    led.append(ev('2026-06-10T20:00:00'));
    led.append(ev('2026-06-11T08:00:00'));

    const byDay = led.query({ groupBy: ['day'] });
    const days = Object.fromEntries(byDay.map((r) => [r.key.day, r.calls]));
    expect(days).toEqual({ '2026-06-10': 2, '2026-06-11': 1 });

    // Range excludes the 11th (to is exclusive).
    const ranged = led.query({ groupBy: [], from: new Date('2026-06-10T00:00:00').getTime(), to: new Date('2026-06-11T00:00:00').getTime() });
    expect(ranged[0].calls).toBe(2);
  });

  it('groups by entryId for the per-message dimension', () => {
    const led = new UsageLedger(ledgerDir());
    led.append(ev('2026-06-10T09:00:00', { entryId: 'eA' }));
    led.append(ev('2026-06-10T09:00:30', { entryId: 'eA' })); // same message, two steps
    led.append(ev('2026-06-10T09:01:00', { entryId: 'eB' }));

    const byMsg = led.query({ groupBy: ['entryId'] });
    const map = Object.fromEntries(byMsg.map((r) => [r.key.entryId, r.calls]));
    expect(map).toEqual({ eA: 2, eB: 1 });
  });

  it('partitionOf derives a local YYYY-MM label', () => {
    expect(partitionOf(new Date('2026-06-15T12:00:00').getTime())).toBe('2026-06');
  });
});
