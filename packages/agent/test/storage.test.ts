import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/storage/session-store.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'zt-sess-')), 'session.jsonl');
}

describe('SessionStore — append-only session tree (agent §5.3/§5.4)', () => {
  let store: SessionStore;
  beforeEach(() => {
    store = new SessionStore(tmpFile());
  });

  it('folds appended entries into an active path', () => {
    const u = store.appendEntry({ kind: 'user', content: [{ type: 'text', text: 'hi' }] });
    const a = store.appendEntry({ kind: 'assistant', content: [{ type: 'text', text: 'yo' }] });
    expect(store.headId).toBe(a.id);
    const path = store.getPath();
    expect(path.map((e) => e.id)).toEqual([u.id, a.id]);
  });

  it('fork branches off an older entry without losing history', () => {
    const u = store.appendEntry({ kind: 'user', content: [{ type: 'text', text: 'a' }] });
    const a1 = store.appendEntry({ kind: 'assistant', content: [{ type: 'text', text: 'b' }] });
    store.fork(u.id);
    const a2 = store.appendEntry({ kind: 'assistant', content: [{ type: 'text', text: 'c' }] });
    // new active path goes u -> a2, but a1 still exists in the tree
    expect(store.getPath().map((e) => e.id)).toEqual([u.id, a2.id]);
    expect(store.getEntry(a1.id)).toBeDefined();
    expect(store.getChildren(u.id).map((e) => e.id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it('stops the active path at the nearest summary ancestor (compaction baseline)', () => {
    store.appendEntry({ kind: 'user', content: [{ type: 'text', text: 'old' }] });
    const s = store.appendEntry({
      kind: 'summary',
      content: [{ type: 'text', text: 'summary' }],
      summary: { reason: 'threshold', firstKeptEntryId: 'x', tokensBefore: 100, tokensAfter: 10 },
    });
    const a = store.appendEntry({ kind: 'assistant', content: [{ type: 'text', text: 'new' }] });
    expect(store.getPath().map((e) => e.id)).toEqual([s.id, a.id]);
  });

  it('reloads identical state from disk', () => {
    const u = store.appendEntry({ kind: 'user', content: [{ type: 'text', text: 'persist' }] });
    store.reload();
    expect(store.headId).toBe(u.id);
    expect(store.getPath()).toHaveLength(1);
  });

  it('appends off-path (moveHead:false) without polluting the active path (agent §5.6)', () => {
    const u = store.appendEntry({ kind: 'user', content: [{ type: 'text', text: 'task' }] });
    // A sub-agent transcript hangs under the turn root but must not move head.
    const sub = store.appendEntry(
      { parentId: u.id, agentId: 'sub-coder-1', kind: 'assistant', content: [{ type: 'text', text: 'sub work' }] },
      { moveHead: false },
    );
    expect(store.headId).toBe(u.id); // head unchanged
    // The orchestrator's turn chains from the user entry, not the sub transcript.
    const a = store.appendEntry({ kind: 'assistant', content: [{ type: 'text', text: 'final' }] });
    expect(a.parentId).toBe(u.id);
    expect(store.getPath().map((e) => e.id)).toEqual([u.id, a.id]);
    // ...but the sub transcript is still in the tree for trace-tree navigation.
    expect(store.getEntry(sub.id)).toBeDefined();
    expect(store.getChildren(u.id).map((e) => e.id).sort()).toEqual([sub.id, a.id].sort());
  });
});
