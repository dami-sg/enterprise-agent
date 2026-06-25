/**
 * Pluggable memory backend factory (cross-channel-memory §4.0). The core
 * (`packages/agent`) depends only on `MemoryPort`; concrete engines live here at
 * the edge and are selected by config, so swapping the memory library never
 * touches the core or the turn loop.
 *
 * mem0 is the planned default (§4.1) but is DEFERRED — no real engine is wired
 * yet. Until one is chosen, run with 'mock' (dev/integration tests) or 'none'
 * (memory off). Adding a real backend = one more `case` here + an adapter that
 * `implements MemoryPort`; nothing upstream changes.
 */
import type { MemoryPort } from '@enterprise-agent/agent-contract';
import { InMemoryMemory } from './mock-memory.js';

export type MemoryBackend = 'none' | 'mock' | 'mem0';

export interface CreateMemoryOptions {
  /** Which backend to construct. Default 'none' (memory off). */
  backend?: MemoryBackend;
}

/**
 * Construct the host's MemoryPort, or `undefined` to leave memory off (the
 * turn-loop hooks then degrade to no-ops — memory §1). Inject the result via
 * `new AgentHost({ memory })`.
 */
export function createMemory(opts: CreateMemoryOptions = {}): MemoryPort | undefined {
  const backend = opts.backend ?? 'none';
  switch (backend) {
    case 'none':
      return undefined;
    case 'mock':
      return new InMemoryMemory();
    case 'mem0':
      throw new Error(
        'memory backend "mem0" is not wired yet (deferred). Use backend "mock" ' +
          'for now; see specs/cross-channel-memory.md §4.',
      );
    default:
      throw new Error(`unknown memory backend: ${backend as string}`);
  }
}

export { InMemoryMemory } from './mock-memory.js';
export type { GovernableMemory, MemoryRecord } from './mock-memory.js';

import type { GovernableMemory } from './mock-memory.js';

/**
 * Narrow a MemoryPort to the optional governance surface (list/forget) used by
 * the `/memories` / `/forget` commands (§5.4). Returns undefined when the
 * backend doesn't support it, so governance degrades gracefully (§4.0).
 */
export function asGovernable(memory: MemoryPort | undefined): GovernableMemory | undefined {
  if (
    memory &&
    typeof (memory as Partial<GovernableMemory>).list === 'function' &&
    typeof (memory as Partial<GovernableMemory>).forget === 'function'
  ) {
    return memory as GovernableMemory;
  }
  return undefined;
}
