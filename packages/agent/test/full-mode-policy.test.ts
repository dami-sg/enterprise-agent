/**
 * `full` execution-mode policy (agent §3.8.5). The deterministic high-risk gate
 * that decides which calls STILL need approval in `full` mode. Fail-closed:
 * anything not positively safe must approve. See tools/full-mode-policy.ts.
 */
import { describe, it, expect } from 'vitest';
import { requiresApprovalInFull } from '../src/tools/full-mode-policy.js';
import type { GatedToolCall } from '../src/tools/gate.js';

const ROOTS = ['/work/repo'];

/** Build a runCommand GatedToolCall. */
function cmd(command: string, args: string[] = []): GatedToolCall {
  return { toolName: 'runCommand', toolCallId: 't', input: { command, args }, grantKey: command, grantScope: 's' };
}

const needsApproval = (c: GatedToolCall) => requiresApprovalInFull(c, ROOTS);

describe('requiresApprovalInFull — un-exemptible high-risk set (→ approve)', () => {
  it('any interpreter or privilege-escalation shim (inline code is unvettable)', () => {
    for (const c of [
      cmd('bash', ['-c', 'echo hi']),
      cmd('sh', ['-c', 'rm x']),
      cmd('/bin/bash', ['-c', 'ls']),
      cmd('python3', ['script.py']),
      cmd('node', ['-e', 'process.exit()']),
      cmd('sudo', ['apt', 'install', 'x']),
      cmd('doas', ['rm', 'x']),
      cmd('su', ['-']),
    ]) {
      expect(needsApproval(c), c.input && JSON.stringify(c.input)).toBe(true);
    }
  });

  it('disk / filesystem destroyers regardless of args', () => {
    expect(needsApproval(cmd('mkfs.ext4', ['/dev/sda1']))).toBe(true);
    expect(needsApproval(cmd('dd', ['if=/dev/zero', 'of=/dev/sda']))).toBe(true);
    expect(needsApproval(cmd('shred', ['-u', 'file']))).toBe(true);
    expect(needsApproval(cmd('wipefs', ['-a', '/dev/sdb']))).toBe(true);
  });

  it('network listeners / reverse-shell tools', () => {
    expect(needsApproval(cmd('nc', ['-l', '-p', '4444']))).toBe(true);
    expect(needsApproval(cmd('ncat', ['-lvp', '9001']))).toBe(true);
    expect(needsApproval(cmd('socat', ['TCP-LISTEN:8080', 'EXEC:/bin/sh']))).toBe(true);
  });

  it('system-level destructive deletion (target escapes the workspace or is broad)', () => {
    expect(needsApproval(cmd('rm', ['-rf', '/']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '~']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '$HOME']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '/etc/nginx']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '*']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '../../secrets']))).toBe(true);
    expect(needsApproval(cmd('rmdir', ['/var/data']))).toBe(true);
    expect(needsApproval(cmd('find', ['/', '-name', '*.log', '-delete']))).toBe(true);
    expect(needsApproval(cmd('git', ['clean', '-fdx']))).toBe(true);
    // flags-only (shell would have expanded the glob) → fail-closed
    expect(needsApproval(cmd('rm', ['-rf']))).toBe(true);
  });

  it('runScript is always gated (script body is unvettable)', () => {
    expect(requiresApprovalInFull({ toolName: 'runScript', toolCallId: 't', input: { interpreter: 'bash', length: 5 }, grantKey: 'bash', grantScope: 's' }, ROOTS)).toBe(true);
  });

  it('malformed runCommand input fails closed', () => {
    expect(requiresApprovalInFull({ toolName: 'runCommand', toolCallId: 't', input: {}, grantKey: '', grantScope: 's' }, ROOTS)).toBe(true);
    expect(requiresApprovalInFull({ toolName: 'runCommand', toolCallId: 't', input: null, grantKey: '', grantScope: 's' }, ROOTS)).toBe(true);
  });
});

describe('requiresApprovalInFull — full-mode-allowed (→ run unprompted)', () => {
  it('ordinary read-only / build / vcs commands', () => {
    for (const c of [
      cmd('git', ['status']),
      cmd('git', ['diff']),
      cmd('ls', ['-la']),
      cmd('grep', ['-r', 'foo', 'src']),
      cmd('rg', ['pattern']),
      cmd('pnpm', ['test']),
      cmd('npm', ['run', 'build']),
      cmd('mkdir', ['tmp']),
      cmd('echo', ['hi']),
    ]) {
      expect(needsApproval(c), JSON.stringify(c.input)).toBe(false);
    }
  });

  it('deletion strictly inside the workspace', () => {
    expect(needsApproval(cmd('rm', ['-rf', 'node_modules']))).toBe(false);
    expect(needsApproval(cmd('rm', ['dist/foo.js']))).toBe(false);
    expect(needsApproval(cmd('rm', ['-rf', '/work/repo/build']))).toBe(false);
    expect(needsApproval(cmd('rm', ['./tmp/x']))).toBe(false);
  });

  it('non-listening use of a network tool is allowed (no -l flag)', () => {
    expect(needsApproval(cmd('nc', ['example.com', '80']))).toBe(false);
  });

  it('non-exec tools (file/network) are not gated by this policy', () => {
    expect(requiresApprovalInFull({ toolName: 'writeFile', toolCallId: 't', input: { path: 'a' }, grantKey: 'a', grantScope: 's' }, ROOTS)).toBe(false);
    expect(requiresApprovalInFull({ toolName: 'httpFetch', toolCallId: 't', input: { url: 'x' }, grantKey: 'x', grantScope: 's' }, ROOTS)).toBe(false);
  });
});
