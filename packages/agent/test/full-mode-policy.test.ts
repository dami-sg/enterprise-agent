/**
 * `full` execution-mode policy (agent §3.8.5). In full mode the gate prompts ONLY
 * for privilege escalation and high-risk destructive deletion; everything else —
 * interpreters, scripts, disk tools, listeners — runs unprompted, and the
 * workspace boundary guardrail is off. See tools/full-mode-policy.ts.
 */
import { describe, it, expect } from 'vitest';
import { requiresApprovalInFull } from '../src/tools/full-mode-policy.js';
import type { GatedToolCall } from '../src/tools/gate.js';

/** Build a runCommand GatedToolCall. */
function cmd(command: string, args: string[] = []): GatedToolCall {
  return { toolName: 'runCommand', toolCallId: 't', input: { command, args }, grantKey: command, grantScope: 's' };
}

const needsApproval = (c: GatedToolCall) => requiresApprovalInFull(c);

describe('requiresApprovalInFull — the only gated set (→ approve)', () => {
  it('privilege escalation', () => {
    for (const c of [
      cmd('sudo', ['apt', 'install', 'x']),
      cmd('doas', ['rm', 'x']),
      cmd('su', ['-']),
      cmd('pkexec', ['whoami']),
      cmd('/usr/bin/sudo', ['reboot']),
    ]) {
      expect(needsApproval(c), JSON.stringify(c.input)).toBe(true);
    }
  });

  it('high-risk destructive deletion (root / home / broad glob / system dir)', () => {
    expect(needsApproval(cmd('rm', ['-rf', '/']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '~']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '$HOME']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '/etc/nginx']))).toBe(true);
    expect(needsApproval(cmd('rm', ['-rf', '*']))).toBe(true);
    expect(needsApproval(cmd('rmdir', ['/var/data']))).toBe(true);
    expect(needsApproval(cmd('find', ['/', '-name', '*.log', '-delete']))).toBe(true);
  });
});

describe('requiresApprovalInFull — everything else runs unprompted (→ false)', () => {
  it('interpreters and inline code (boundary off — they run unprompted)', () => {
    for (const c of [
      cmd('bash', ['-c', 'echo hi']),
      cmd('sh', ['-c', 'rm x']),
      cmd('/bin/bash', ['-c', 'ls']),
      cmd('python3', ['script.py']),
      cmd('node', ['-e', 'process.exit()']),
    ]) {
      expect(needsApproval(c), JSON.stringify(c.input)).toBe(false);
    }
  });

  it('disk tools and network listeners are no longer gated', () => {
    expect(needsApproval(cmd('mkfs.ext4', ['/dev/sda1']))).toBe(false);
    expect(needsApproval(cmd('dd', ['if=/dev/zero', 'of=/dev/sda']))).toBe(false);
    expect(needsApproval(cmd('shred', ['-u', 'file']))).toBe(false);
    expect(needsApproval(cmd('nc', ['-l', '-p', '4444']))).toBe(false);
    expect(needsApproval(cmd('socat', ['TCP-LISTEN:8080', 'EXEC:/bin/sh']))).toBe(false);
  });

  it('runScript runs unprompted', () => {
    expect(
      requiresApprovalInFull({ toolName: 'runScript', toolCallId: 't', input: { interpreter: 'bash', length: 5 }, grantKey: 'bash', grantScope: 's' }),
    ).toBe(false);
  });

  it('deletion of specific paths (in- or out-of-workspace, non-system) is allowed', () => {
    expect(needsApproval(cmd('rm', ['-rf', 'node_modules']))).toBe(false);
    expect(needsApproval(cmd('rm', ['dist/foo.js']))).toBe(false);
    expect(needsApproval(cmd('rm', ['-rf', '/work/repo/build']))).toBe(false);
    expect(needsApproval(cmd('rm', ['-rf', '/tmp/scratch']))).toBe(false); // out-of-workspace, non-system
    expect(needsApproval(cmd('git', ['clean', '-fdx']))).toBe(false); // confined to repo
  });

  it('ordinary read-only / build / vcs commands', () => {
    for (const c of [cmd('git', ['status']), cmd('ls', ['-la']), cmd('pnpm', ['test']), cmd('echo', ['hi'])]) {
      expect(needsApproval(c), JSON.stringify(c.input)).toBe(false);
    }
  });

  it('malformed input and non-exec tools are not gated', () => {
    expect(requiresApprovalInFull({ toolName: 'runCommand', toolCallId: 't', input: {}, grantKey: '', grantScope: 's' })).toBe(false);
    expect(requiresApprovalInFull({ toolName: 'runCommand', toolCallId: 't', input: null, grantKey: '', grantScope: 's' })).toBe(false);
    expect(requiresApprovalInFull({ toolName: 'writeFile', toolCallId: 't', input: { path: 'a' }, grantKey: 'a', grantScope: 's' })).toBe(false);
    expect(requiresApprovalInFull({ toolName: 'httpFetch', toolCallId: 't', input: { url: 'x' }, grantKey: 'x', grantScope: 's' })).toBe(false);
  });
});
