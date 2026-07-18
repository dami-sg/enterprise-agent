/**
 * uploadFile (multimodal Route C): persists user uploads into the session
 * root's `uploads/` dir — sanitized single-segment names (CJK preserved),
 * collision suffixes, 50MB cap, path-escape guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHost } from '../src/index.js';
import type { AgentHost } from '@dami-sg/agent-contract';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'up-home-'));
}

const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('AgentHost.uploadFile (multimodal Route C)', () => {
  let home: string;
  let work: string;
  let host: AgentHost;
  let sessionId: string;

  beforeEach(async () => {
    home = tmpHome();
    work = mkdtempSync(join(tmpdir(), 'up-work-'));
    host = createAgentHost({ root: home });
    sessionId = (await host.createSession({ name: 'up', workingDir: work })).id;
  });

  it('writes the bytes into uploads/ and returns the relative path + size', async () => {
    const res = await host.uploadFile(sessionId, 'a.txt', b64('hello'));
    expect(res).toEqual({ path: 'uploads/a.txt', size: 5 });
    expect(readFileSync(join(work, 'uploads', 'a.txt'), 'utf8')).toBe('hello');
  });

  it('preserves CJK filenames', async () => {
    const res = await host.uploadFile(sessionId, '报告.txt', b64('x'));
    expect(res.path).toBe('uploads/报告.txt');
    expect(existsSync(join(work, 'uploads', '报告.txt'))).toBe(true);
  });

  it('sanitizes path traversal to a single segment inside uploads/', async () => {
    const res = await host.uploadFile(sessionId, '../../../evil.txt', b64('x'));
    expect(res.path.startsWith('uploads/')).toBe(true);
    // The name collapsed to a single segment: no separators left after the prefix.
    expect(res.path.slice('uploads/'.length)).not.toMatch(/[/\\]/);
    // Nothing escaped the working directory.
    expect(existsSync(join(work, '..', 'evil.txt'))).toBe(false);
    expect(readdirSync(join(work, 'uploads'))).toHaveLength(1);
  });

  it('sanitizes backslash separators too', async () => {
    const res = await host.uploadFile(sessionId, '..\\..\\evil.txt', b64('x'));
    expect(res.path.startsWith('uploads/')).toBe(true);
    expect(existsSync(join(work, 'uploads'))).toBe(true);
  });

  it('de-collides duplicate names with -1, -2 suffixes', async () => {
    expect((await host.uploadFile(sessionId, 'a.txt', b64('1'))).path).toBe('uploads/a.txt');
    expect((await host.uploadFile(sessionId, 'a.txt', b64('2'))).path).toBe('uploads/a-1.txt');
    expect((await host.uploadFile(sessionId, 'a.txt', b64('3'))).path).toBe('uploads/a-2.txt');
    expect(readFileSync(join(work, 'uploads', 'a-1.txt'), 'utf8')).toBe('2');
  });

  it('rejects payloads over 50MB', async () => {
    // 50MB + 1 byte of zeros (base64 of a Buffer allocation; fast enough).
    const big = Buffer.alloc(50 * 1024 * 1024 + 1).toString('base64');
    await expect(host.uploadFile(sessionId, 'big.bin', big)).rejects.toThrow(/50MB/);
  });

  it('rejects an unknown session', async () => {
    await expect(host.uploadFile('nope', 'a.txt', b64('x'))).rejects.toThrow(/session not found/);
  });

  it('createSession materializes a nonexistent workingDir (typed remote paths)', async () => {
    const dir = join(work, 'newly', 'typed', 'dir');
    expect(existsSync(dir)).toBe(false);
    await host.createSession({ name: 'typed', workingDir: dir });
    expect(existsSync(dir)).toBe(true);
  });

  it('createSession resolves workspaceName under <root>/workspaces (remote clients)', async () => {
    const s = await host.createSession({ name: 'ws', workspaceName: 'proj1' });
    expect(s.workingDir).toBe(join(home, 'workspaces', 'proj1'));
    expect(existsSync(join(home, 'workspaces', 'proj1'))).toBe(true);
    // Empty name → the shared `default` workspace.
    const d = await host.createSession({ name: 'ws2', workspaceName: '' });
    expect(d.workingDir).toBe(join(home, 'workspaces', 'default'));
    // Traversal collapses to a single safe segment inside workspaces/.
    const evil = await host.createSession({ name: 'ws3', workspaceName: '../../etc' });
    expect(evil.workingDir!.startsWith(join(home, 'workspaces'))).toBe(true);
    expect(existsSync(join(home, 'etc'))).toBe(false);
    // workingDir wins over workspaceName when both are present.
    const both = await host.createSession({ name: 'ws4', workingDir: work, workspaceName: 'ignored' });
    expect(both.workingDir).toBe(work);
  });

  it('readArtifact serves byte ranges so clients can chunk large files', async () => {
    const { writeFileSync: wf } = await import('node:fs');
    wf(join(work, 'big.txt'), 'hello world');
    // Artifacts come from the ArtifactStore — append the manifest entry through
    // the same store/path the host reads.
    const { ArtifactStore } = await import('../src/storage/artifact-store.js');
    const { createPaths } = await import('../src/config/paths.js');
    new ArtifactStore(createPaths(home).sessionArtifacts(sessionId)).append({
      id: 'a1',
      name: 'big',
      kind: 'document',
      path: 'big.txt',
      size: 11,
      createdAt: 1,
    });
    const full = await host.readArtifact(sessionId, 'a1');
    expect([full.base64, full.truncated, full.size]).toEqual([Buffer.from('hello world').toString('base64'), false, 11]);
    const slice = await host.readArtifact(sessionId, 'a1', { offset: 6, length: 5 });
    expect(Buffer.from(slice.base64, 'base64').toString()).toBe('world');
    expect(slice.truncated).toBe(false); // 6+5 = size → whole tail delivered
    const mid = await host.readArtifact(sessionId, 'a1', { offset: 0, length: 5 });
    expect(Buffer.from(mid.base64, 'base64').toString()).toBe('hello');
    expect(mid.truncated).toBe(true); // more bytes remain
    const past = await host.readArtifact(sessionId, 'a1', { offset: 100, length: 5 });
    expect(past.base64).toBe('');
    expect(past.truncated).toBe(false);
  });

  it('writes under the scratch root for a session without a workingDir', async () => {
    const scratch = (await host.createSession({ name: 'scratch' })).id;
    const res = await host.uploadFile(scratch, 'b.txt', b64('y'));
    expect(res.path).toBe('uploads/b.txt');
    // Scratch root lives under the app home (paths.sessionScratch).
    const found = readdirSync(home, { recursive: true }).some((p) => String(p).endsWith(join('uploads', 'b.txt')));
    expect(found).toBe(true);
  });
});
