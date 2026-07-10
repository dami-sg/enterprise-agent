/**
 * Chat-side approval rendering (gateway §6.1, "做厚聊天"): the approval message
 * should show WHAT is being approved — not just the tool name / scope — so the
 * decision can be made from chat. Bounded by what core surfaces in `input`.
 */
import { describe, it, expect } from 'vitest';
import { approvalView } from '../src/runtime/approval.js';

describe('approvalView', () => {
  it('shows the full command line for runCommand (executable + args)', () => {
    const v = approvalView('runCommand', undefined, { command: 'git', args: ['push', '--force'] });
    expect(v.text).toContain('工具：`runCommand`');
    expect(v.text).toContain('git push --force');
    expect(v.text).toMatch(/```[\s\S]*git push --force[\s\S]*```/);
  });

  it('shows the detail EVEN WHEN a grantScope is present (both, not either/or)', () => {
    const v = approvalView('runCommand', 'run `git *` for this task', { command: 'git', args: ['push'] });
    expect(v.text).toContain('范围：');
    expect(v.text).toContain('git push'); // regression guard: old code hid this under grantScope
  });

  it('notes a runScript by interpreter (body is not surfaced by core)', () => {
    const v = approvalView('runScript', undefined, { interpreter: 'python3', length: 412 });
    expect(v.text).toContain('python3');
    expect(v.text).toContain('412');
  });

  it('shows method + url for httpFetch', () => {
    const v = approvalView('httpFetch', undefined, { url: 'https://api.example.com/x', method: 'POST' });
    expect(v.text).toContain('POST https://api.example.com/x');
  });

  it('shows the path for file ops', () => {
    const v = approvalView('writeFile', 'write files under /tmp', { path: '/tmp/out.txt' });
    expect(v.text).toContain('/tmp/out.txt');
  });

  it('shows the content preview for writeFile (core now surfaces it)', () => {
    const v = approvalView('writeFile', 'write files under /tmp', {
      path: '/tmp/out.txt',
      bytes: 11,
      content: 'hello world',
    });
    expect(v.text).toContain('/tmp/out.txt');
    expect(v.text).toContain('hello world');
    expect(v.text).toContain('内容');
  });

  it('renders a find→replace edit as a diff for applyPatch', () => {
    const v = approvalView('applyPatch', 'edit files under /repo', {
      path: '/repo/a.ts',
      find: 'const x = 1',
      replace: 'const x = 2',
    });
    expect(v.text).toContain('```diff');
    expect(v.text).toContain('- const x = 1');
    expect(v.text).toContain('+ const x = 2');
  });

  it('falls back to args JSON for an unknown/MCP tool so the decision is not blind', () => {
    const v = approvalView('mcp__db__query', undefined, { sql: 'DELETE FROM users', limit: 10 });
    expect(v.text).toContain('DELETE FROM users');
  });

  it('truncates an overlong command instead of dumping it whole', () => {
    const v = approvalView('runCommand', undefined, { command: 'echo', args: ['x'.repeat(2000)] });
    expect(v.text).toContain('…');
    expect(v.text.length).toBeLessThan(1200);
  });

  it('always offers the three-state decision', () => {
    const v = approvalView('runCommand', undefined, { command: 'ls' });
    expect(v.choices.map((c) => c.decision)).toEqual(['once', 'session', 'reject']);
  });
});
