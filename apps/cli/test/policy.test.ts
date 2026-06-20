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
    expect(decide(p, req('writeFile', { path: 'x' }))).toBe('reject'); // non-command tool
  });
});
