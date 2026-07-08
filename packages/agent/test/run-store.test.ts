import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/storage/run-store.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'zt-run-')), 'runs.jsonl');
}

describe('RunStore — run tree (agent §5.0/§5.6)', () => {
  let file: string;
  let store: RunStore;
  beforeEach(() => {
    file = tmpFile();
    store = new RunStore(file);
  });

  it('starts a run in the running state and reads it back', () => {
    const run = store.start({ agentId: 'orch' });
    expect(run.status).toBe('running');
    expect(run.agentId).toBe('orch');
    expect(typeof run.startedAt).toBe('number');
    expect(store.get(run.id)).toEqual(run);
  });

  it('honours a pre-allocated id (serialized turn queue needs the id up front)', () => {
    const run = store.start({ id: 'r-fixed', agentId: 'orch' });
    expect(run.id).toBe('r-fixed');
    expect(store.get('r-fixed')?.status).toBe('running');
  });

  it('finish() transitions status and stamps a finish reason + endedAt', () => {
    const run = store.start({ agentId: 'orch' });
    store.finish(run.id, 'done', 'completed');
    const done = store.get(run.id);
    expect(done?.status).toBe('done');
    expect(done?.finishReason).toBe('completed');
    expect(typeof done?.endedAt).toBe('number');
  });

  it('finish() on an unknown runId is a silent no-op', () => {
    expect(() => store.finish('nope', 'error')).not.toThrow();
    expect(store.get('nope')).toBeUndefined();
  });

  it('links sub-runs to their parent', () => {
    const parent = store.start({ agentId: 'orch' });
    const child = store.start({ agentId: 'sub-coder-1', parentRunId: parent.id });
    expect(child.parentRunId).toBe(parent.id);
    expect(store.all().map((r) => r.id).sort()).toEqual([parent.id, child.id].sort());
  });

  it('reloads from the append-only log with last-write-wins per run id', () => {
    // start + finish append TWO lines for the same id; a fresh store must fold
    // them so the reloaded run reflects the final (finished) state, not the
    // stale running one.
    const run = store.start({ agentId: 'orch' });
    store.finish(run.id, 'done', 'ok');

    const reloaded = new RunStore(file);
    const r = reloaded.get(run.id);
    expect(r?.status).toBe('done');
    expect(r?.finishReason).toBe('ok');
    expect(reloaded.all()).toHaveLength(1); // one logical run, not two
  });
});
