/**
 * Slash parsing (gateway §6.2) + admin/user authorization (gateway §6.4).
 */
import { describe, it, expect } from 'vitest';
import { parseSlash, isBuiltin } from '../src/commands/slash.js';
import { isAdmin, isPlatformAdmin, commandAllowed } from '../src/runtime/auth.js';
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

describe('platform-vs-conversation admin split (managed mode, gateway §6.4)', () => {
  const base: ChannelConfig = { name: 'telegram' };

  it('managed DM without an allowlist: conversation-scoped commands stay, /platform fails closed', () => {
    const opts = { managed: true };
    // The bound key-holder still owns their own conversation…
    expect(isAdmin(base, 'u1', opts)).toBe(true);
    expect(commandAllowed(base, 'u1', 'approve', opts)).toBe(true);
    expect(commandAllowed(base, 'u1', 'stop', opts)).toBe(true);
    expect(commandAllowed(base, 'u1', 'reset', opts)).toBe(true);
    // …but must not pause/resume the whole channel for every other user.
    expect(isPlatformAdmin(base, 'u1', opts)).toBe(false);
    expect(commandAllowed(base, 'u1', 'platform', opts)).toBe(false);
  });

  it('open DM without an allowlist keeps the single-user shortcut (personal bot)', () => {
    expect(isPlatformAdmin(base, 'u1')).toBe(true);
    expect(commandAllowed(base, 'u1', 'platform')).toBe(true);
  });

  it('an explicit allowlist grants platform admin regardless of mode', () => {
    const cfg: ChannelConfig = { ...base, allowAdminFrom: ['admin1'] };
    expect(isPlatformAdmin(cfg, 'admin1', { managed: true })).toBe(true);
    expect(commandAllowed(cfg, 'admin1', 'platform', { managed: true })).toBe(true);
    expect(isPlatformAdmin(cfg, 'rando', { managed: true })).toBe(false);
    expect(commandAllowed(cfg, 'rando', 'platform', { managed: true })).toBe(false);
  });

  it('userAllowedCommands cannot grant a platform-wide verb', () => {
    const cfg: ChannelConfig = { ...base, allowAdminFrom: ['admin1'], userAllowedCommands: ['platform'] };
    expect(commandAllowed(cfg, 'rando', 'platform', { managed: true })).toBe(false);
  });

  it('groups fail closed for platform admin in every mode without an allowlist', () => {
    expect(isPlatformAdmin(base, 'u1', { isGroup: true })).toBe(false);
    expect(isPlatformAdmin(base, 'u1', { isGroup: true, managed: true })).toBe(false);
  });
});
