/**
 * Slash parsing (gateway §6.2) + admin/user authorization (gateway §6.4).
 */
import { describe, it, expect } from 'vitest';
import { parseSlash, isBuiltin } from '../src/commands/slash.js';
import { isAdmin, commandAllowed } from '../src/runtime/auth.js';
import type { ChannelConfig } from '../src/config/gateway-config.js';

describe('parseSlash', () => {
  it('parses a verb and its argument', () => {
    expect(parseSlash('/model fast')).toEqual({ name: 'model', arg: 'fast', raw: '/model fast' });
  });
  it('strips a @botname suffix (group form)', () => {
    expect(parseSlash('/approve@my_bot')?.name).toBe('approve');
  });
  it('returns undefined for non-commands', () => {
    expect(parseSlash('hello there')).toBeUndefined();
    expect(parseSlash('  not /a command')).toBeUndefined();
  });
  it('recognizes builtins; a skill name is not builtin', () => {
    expect(isBuiltin('approve')).toBe(true);
    expect(isBuiltin('deepresearch')).toBe(false);
  });
});

describe('authorization (gateway §6.4)', () => {
  const base: ChannelConfig = { name: 'telegram' };

  it('treats everyone as admin when no allowlist is set (single-user bot)', () => {
    expect(isAdmin(base, 'u1')).toBe(true);
    expect(commandAllowed(base, 'u1', 'stop')).toBe(true);
  });

  it('restricts admin commands to listed admins', () => {
    const cfg: ChannelConfig = { ...base, allowAdminFrom: ['admin1'] };
    expect(isAdmin(cfg, 'admin1')).toBe(true);
    expect(isAdmin(cfg, 'rando')).toBe(false);
    expect(commandAllowed(cfg, 'rando', 'stop')).toBe(false); // admin command
    expect(commandAllowed(cfg, 'rando', 'status')).toBe(true); // low-risk
    expect(commandAllowed(cfg, 'admin1', 'stop')).toBe(true);
  });

  it('honors a non-admin command allowlist', () => {
    const cfg: ChannelConfig = { ...base, allowAdminFrom: ['admin1'], userAllowedCommands: ['status'] };
    expect(commandAllowed(cfg, 'rando', 'status')).toBe(true);
    expect(commandAllowed(cfg, 'rando', 'model')).toBe(false); // not in allowlist
  });
});
