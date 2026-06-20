import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the child_process seam so the test asserts *how* `security` is invoked
// without touching the real login keychain.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }));

import { MacKeychain } from '../src/host/keychain.js';

describe('MacKeychain.set (cli §7 / §10)', () => {
  beforeEach(() => execFileSyncMock.mockReset());

  it('never places the secret in argv and feeds it via stdin', () => {
    const secret = 'sk-ant-SECRET-must-not-leak-via-ps';
    new MacKeychain().set('openai.key', secret);

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { input?: string; stdio?: unknown[] },
    ];

    expect(bin).toBe('security');
    // The core invariant: the plaintext key appears in no argv element.
    expect(argv.some((a) => a.includes(secret))).toBe(false);
    // Prompt form: `-w` is the final arg with no inline value; `-U` upsert kept.
    expect(argv).toContain('-U');
    expect(argv[argv.length - 1]).toBe('-w');
    expect(argv).toEqual([
      'add-generic-password',
      '-a',
      'openai.key',
      '-s',
      'enterprise-agent',
      '-U',
      '-w',
    ]);
    // Secret delivered twice (enter + confirm) over stdin, not argv.
    expect(opts.input).toBe(`${secret}\n${secret}\n`);
    expect(opts.stdio?.[0]).toBe('pipe');
  });

  it('preserves the exact secret, including shell-significant characters', () => {
    const secret = 'a b"c`d$(e)&|;\\f';
    new MacKeychain().set('p.key', secret);
    const opts = execFileSyncMock.mock.calls[0][2] as { input: string };
    expect(opts.input).toBe(`${secret}\n${secret}\n`);
  });

  it('rejects a secret with an embedded newline instead of corrupting it', () => {
    expect(() => new MacKeychain().set('p.key', 'line1\nline2')).toThrow();
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
