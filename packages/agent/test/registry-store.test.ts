import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaths } from '../src/config/paths.js';
import { RegistryStore } from '../src/storage/registry-store.js';

function freshStore(): RegistryStore {
  const root = mkdtempSync(join(tmpdir(), 'zt-reg-'));
  return new RegistryStore(createPaths(root));
}

describe('RegistryStore — session registry (agent §5.2/§1.1)', () => {
  let store: RegistryStore;
  beforeEach(() => {
    store = freshStore();
  });

  it('creates a session and reads it back', () => {
    const s = store.createSession({ name: 'first' });
    expect(s.name).toBe('first');
    expect(s.status).toBe('active');
    expect(store.getSession(s.id)).toEqual(s);
    expect(store.listSessions().map((x) => x.id)).toEqual([s.id]);
  });

  it('marks only the very first session active on creation', () => {
    const a = store.createSession({ name: 'a' });
    const b = store.createSession({ name: 'b' });
    expect(store.getSession(a.id)?.isActive).toBe(true);
    expect(store.getSession(b.id)?.isActive).toBe(false);
  });

  it('setActiveSession keeps exactly one session active (agent §1.1)', () => {
    const a = store.createSession({ name: 'a' });
    const b = store.createSession({ name: 'b' });
    store.setActiveSession(b.id);
    const active = store.listSessions().filter((s) => s.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(b.id);
  });

  it('persists mutations via saveSession', () => {
    const s = store.createSession({ name: 'x' });
    store.saveSession({ ...s, name: 'renamed', status: 'archived' });
    const reloaded = store.getSession(s.id);
    expect(reloaded?.name).toBe('renamed');
    expect(reloaded?.status).toBe('archived');
  });

  it('deleteSession removes it from the registry', () => {
    const a = store.createSession({ name: 'a' });
    const b = store.createSession({ name: 'b' });
    store.deleteSession(a.id);
    expect(store.getSession(a.id)).toBeUndefined();
    expect(store.listSessions().map((s) => s.id)).toEqual([b.id]);
  });

  it('binds an explicit workingDir when provided', () => {
    const s = store.createSession({ name: 'w', workingDir: '/tmp/my-project' });
    expect(store.getSession(s.id)?.workingDir).toBe('/tmp/my-project');
  });
});
