/**
 * Web sessions + history API (web-app §4.2): account-scoped listing and
 * transcript reads. The load-bearing invariant is authorization — an account
 * sees ONLY sessions whose memoryNamespace == its accountId; another account's
 * session reads back as "not found".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentHost, Entry, Session, SessionTree } from '@enterprise-agent/agent-contract';
import { Router } from '../src/runtime/router.js';
import {
  deleteAccountSession,
  listAccountSessions,
  readSessionHistory,
  renameAccountSession,
} from '../src/web/sessions-api.js';

interface HostCalls {
  renamed: Array<{ id: string; name: string }>;
  deleted: string[];
}

/** Minimal stand-in exposing the session ops the API uses, recording mutations. */
function fakeHost(
  sessions: Session[],
  trees: Record<string, SessionTree> = {},
  calls: HostCalls = { renamed: [], deleted: [] },
): Pick<AgentHost, 'listSessions' | 'getSessionTree' | 'renameSession' | 'deleteSession'> {
  return {
    listSessions: async () => sessions,
    getSessionTree: async (id: string) => trees[id] ?? { nodes: {} },
    renameSession: async (id: string, name: string) => {
      calls.renamed.push({ id, name });
      return {} as Session;
    },
    deleteSession: async (id: string) => {
      calls.deleted.push(id);
    },
  };
}

function session(id: string, namespace: string | undefined, name = id): Session {
  return { id, name, config: namespace ? { memoryNamespace: namespace } : {}, isActive: false, status: 'idle', todos: [], usage: {} } as unknown as Session;
}

function textEntry(id: string, kind: 'user' | 'assistant', text: string, parentId?: string, ts = 0): Entry {
  return { type: 'entry', id, parentId, kind, content: [{ type: 'text', text }], ts } as Entry;
}

/** A simple linear tree u1 → a1 → u2 → a2 with head at a2. */
function linearTree(): SessionTree {
  const nodes: Record<string, Entry> = {
    u1: textEntry('u1', 'user', 'hi', undefined, 1),
    a1: textEntry('a1', 'assistant', 'hello', 'u1', 2),
    u2: textEntry('u2', 'user', 'bye', 'a1', 3),
    a2: textEntry('a2', 'assistant', 'goodbye', 'u2', 4),
  };
  return { rootId: 'u1', headId: 'a2', nodes, labels: {} };
}

let dir: string;
let router: Router;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-sessapi-'));
  router = new Router(join(dir, 'routes.json'));
  return () => rmSync(dir, { recursive: true, force: true });
});

describe('listAccountSessions', () => {
  it('returns only the account’s own sessions, with thread ids from routes', () => {
    router.bind('web', 'th1', 's1', 1);
    const host = fakeHost(
      [session('s1', 'acct_a'), session('s2', 'acct_b'), session('s3', 'acct_a'), session('s4', undefined)],
      {},
    );
    return listAccountSessions(host, 'acct_a', router).then((list) => {
      expect(list.map((s) => s.sessionId).sort()).toEqual(['s1', 's3']);
      expect(list.find((s) => s.sessionId === 's1')!.threadId).toBe('th1');
    });
  });
});

describe('readSessionHistory', () => {
  it('returns the linear user/assistant transcript in order', async () => {
    const host = fakeHost([session('s1', 'acct_a')], { s1: linearTree() });
    const msgs = await readSessionHistory(host, 'acct_a', 's1');
    expect(msgs!.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hi', 'assistant:hello', 'user:bye', 'assistant:goodbye']);
  });

  it('refuses another account’s session (authorization → not found)', async () => {
    const host = fakeHost([session('s1', 'acct_a')], { s1: linearTree() });
    expect(await readSessionHistory(host, 'acct_b', 's1')).toBeUndefined();
  });

  it('returns undefined for an unknown session', async () => {
    const host = fakeHost([session('s1', 'acct_a')], {});
    expect(await readSessionHistory(host, 'acct_a', 'nope')).toBeUndefined();
  });
});

describe('rename / delete (account-authorized)', () => {
  it('renames an owned session; refuses another account’s', async () => {
    const calls: HostCalls = { renamed: [], deleted: [] };
    const host = fakeHost([session('s1', 'acct_a')], {}, calls);
    expect(await renameAccountSession(host, 'acct_a', 's1', 'New name')).toBe(true);
    expect(calls.renamed).toEqual([{ id: 's1', name: 'New name' }]);
    expect(await renameAccountSession(host, 'acct_b', 's1', 'Hijack')).toBe(false);
    expect(calls.renamed).toHaveLength(1); // not called for the non-owner
  });

  it('deletes an owned session and unbinds its web route; refuses another account’s', async () => {
    const calls: HostCalls = { renamed: [], deleted: [] };
    const host = fakeHost([session('s1', 'acct_a')], {}, calls);
    router.bind('web', 'th1', 's1', 1);
    expect(await deleteAccountSession(host, router, 'acct_a', 's1')).toBe(true);
    expect(calls.deleted).toEqual(['s1']);
    expect(router.lookup('web', 'th1')).toBeUndefined(); // route unbound
    // a non-owner cannot delete
    const host2 = fakeHost([session('s2', 'acct_a')], {}, calls);
    expect(await deleteAccountSession(host2, router, 'acct_b', 's2')).toBe(false);
    expect(calls.deleted).toEqual(['s1']);
  });
});
