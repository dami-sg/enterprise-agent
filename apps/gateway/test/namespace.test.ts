/**
 * Memory namespace policy (cross-channel-memory §3 / §5.1). Proves the isolation
 * invariant against a real IdentityStore: bound private chat → accountId; group
 * chat → undefined; unbound private chat → undefined (never the shared pool).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityStore } from '../src/accounts/identity-store.js';
import { resolveNamespace } from '../src/memory/namespace.js';

function withStore(): { store: IdentityStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gw-ns-'));
  return { store: new IdentityStore(join(dir, 'identity')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('resolveNamespace (memory isolation, §5.1)', () => {
  it('bound private chat → the accountId', () => {
    const { store, cleanup } = withStore();
    const a = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    const ns = resolveNamespace((p, u) => store.resolveAccount(p, u), {
      channel: 'telegram',
      userId: '111',
      isPrivate: true,
    });
    expect(ns).toBe(a.accountId);
    cleanup();
  });

  it('group chat → undefined (no memory), even if the user is bound', () => {
    const { store, cleanup } = withStore();
    const a = store.createAccount();
    store.bind('telegram', '111', a.accountId);
    const ns = resolveNamespace((p, u) => store.resolveAccount(p, u), {
      channel: 'telegram',
      userId: '111',
      isPrivate: false,
    });
    expect(ns).toBeUndefined();
    cleanup();
  });

  it('unbound private chat → undefined (never the shared default pool)', () => {
    const { store, cleanup } = withStore();
    const ns = resolveNamespace((p, u) => store.resolveAccount(p, u), {
      channel: 'telegram',
      userId: '999',
      isPrivate: true,
    });
    expect(ns).toBeUndefined();
    cleanup();
  });
});
