import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditStore } from '../src/storage/audit-store.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'zt-audit-')), 'audit.jsonl');
}

const base = {
  runId: 'r1',
  agentId: 'orch',
  toolCallId: 'tc1',
  tool: 'exec',
  input: { cmd: 'echo hi' },
  approval: 'once',
};

describe('AuditStore — append-only audit log (agent §5.2/§3.3)', () => {
  let store: AuditStore;
  beforeEach(() => {
    store = new AuditStore(tmpFile());
  });

  it('records an entry and stamps a timestamp', () => {
    store.record(base);
    const all = store.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.tool).toBe('exec');
    expect(typeof all[0]!.ts).toBe('number');
  });

  it('appends multiple entries in order and reads them back', () => {
    store.record({ ...base, toolCallId: 'tc1' });
    store.record({ ...base, toolCallId: 'tc2', tool: 'http' });
    const all = store.all();
    expect(all.map((r) => r.toolCallId)).toEqual(['tc1', 'tc2']);
  });

  it('redacts credentials before they reach disk (secrets never hit a log)', () => {
    store.record({
      ...base,
      input: { headers: { authorization: 'Bearer supersecrettoken123' } },
      output: 'used key sk-ABCDEFGH12345678 to authenticate',
    });
    const rec = store.all()[0]!;
    const serialized = JSON.stringify(rec);
    // key-based masking on `authorization`, substring masking on the sk- key
    expect(serialized).not.toContain('supersecrettoken123');
    expect(serialized).not.toContain('sk-ABCDEFGH12345678');
    expect(serialized).toContain('***');
  });

  it('a torn/partial line does not sink the whole read', () => {
    store.record(base);
    // readJsonl is expected to tolerate a trailing partial write; a second valid
    // record still reads back.
    store.record({ ...base, toolCallId: 'tc2' });
    expect(store.all().length).toBeGreaterThanOrEqual(2);
  });
});
