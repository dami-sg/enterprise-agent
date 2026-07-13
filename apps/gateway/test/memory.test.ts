/**
 * Integration test for the pluggable memory wiring (cross-channel-memory §4.0,
 * §5). Exercises factory selection + the in-memory mock backend end-to-end:
 * capture→retrieve within an account namespace (the cross-session / cross-channel
 * sharing promise), isolation across namespaces, and the list/forget governance
 * surface (§5.4). No real engine — this pins the seam a real backend drops into.
 */
import { describe, it, expect } from 'vitest';
import type { MemoryScope } from '@dami-sg/agent-contract';
import { createMemory, InMemoryMemory, type GovernableMemory } from '../src/memory/index.js';

const alice: MemoryScope = { namespace: 'acct_alice' };
const bob: MemoryScope = { namespace: 'acct_bob' };

describe('createMemory factory (pluggable backend, §4.0)', () => {
  it('returns undefined for "none" and by default (memory off)', () => {
    expect(createMemory({ backend: 'none' })).toBeUndefined();
    expect(createMemory()).toBeUndefined();
  });

  it('returns the in-memory mock for "mock"', () => {
    expect(createMemory({ backend: 'mock' })).toBeInstanceOf(InMemoryMemory);
  });

  it('throws for the deferred "mem0" backend (not wired yet)', () => {
    expect(() => createMemory({ backend: 'mem0' })).toThrow(/not wired yet|deferred/i);
  });

  it('throws for an unknown backend', () => {
    expect(() => createMemory({ backend: 'bogus' as never })).toThrow(/unknown memory backend/i);
  });
});

describe('InMemoryMemory backend (account-scoped recall, §5.1)', () => {
  it('captures then recalls within the same namespace (cross-session sharing)', async () => {
    const mem = createMemory({ backend: 'mock' }) as GovernableMemory;
    // "Session A" (e.g. Telegram) captures a fact under the account.
    await mem.capture(alice, { messages: [{ role: 'user', text: 'I love sci-fi movies' }] });
    // "Session B" (e.g. Web), same accountId → recalls it.
    const hits = await mem.retrieve(alice, 'what movies do I like?', { topK: 6 });
    expect(hits.map((h) => h.text)).toContain('I love sci-fi movies');
  });

  it('isolates namespaces: another account never sees the fact', async () => {
    const mem = createMemory({ backend: 'mock' }) as GovernableMemory;
    await mem.capture(alice, { messages: [{ role: 'user', text: 'I love sci-fi movies' }] });
    const hits = await mem.retrieve(bob, 'what movies do I like?', { topK: 6 });
    expect(hits).toHaveLength(0);
  });

  it('returns nothing for an empty query and respects topK', async () => {
    const mem = new InMemoryMemory();
    for (let i = 0; i < 10; i++) {
      await mem.capture(alice, { messages: [{ role: 'user', text: `fact ${i}` }] });
    }
    expect(await mem.retrieve(alice, '', { topK: 6 })).toHaveLength(0);
    expect(await mem.retrieve(alice, 'q', { topK: 3 })).toHaveLength(3);
  });

  it('governance (§5.4): list then forget removes the record from recall', async () => {
    const mem = createMemory({ backend: 'mock' }) as GovernableMemory;
    await mem.capture(alice, { messages: [{ role: 'user', text: 'remember X' }] });
    const listed = await mem.list(alice);
    expect(listed).toHaveLength(1);
    const id = listed[0].id;
    expect(await mem.forget(alice, id)).toBe(true);
    expect(await mem.list(alice)).toHaveLength(0);
    expect(await mem.retrieve(alice, 'X', { topK: 6 })).toHaveLength(0);
    expect(await mem.forget(alice, id)).toBe(false); // already gone
  });

  it('maintain is a no-op-safe call', async () => {
    const mem = new InMemoryMemory();
    await expect(mem.maintain()).resolves.toBeUndefined();
  });
});
