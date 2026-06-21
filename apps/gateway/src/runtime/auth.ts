/**
 * Authorization & privilege partitioning (gateway §6.4). Borrowed from Hermes'
 * admin/user split: a channel may restrict who can fire high-risk commands and
 * which commands a non-admin may run at all. The `userId` (gateway §3.2) is the
 * subject. Pure functions so the policy is unit-testable.
 */
import type { ChannelConfig } from '../config/gateway-config.js';
import { ADMIN_COMMANDS } from '../commands/slash.js';

/**
 * Is `userId` an admin on this channel? When `allowAdminFrom` is unset/empty the
 * channel is single-user (a personal assistant bot, the common §8 case) and
 * everyone is admin; once an allowlist is configured, only listed ids are.
 */
export function isAdmin(cfg: ChannelConfig, userId: string): boolean {
  const admins = cfg.allowAdminFrom;
  if (!admins || admins.length === 0) return true;
  return admins.includes(userId);
}

/**
 * May `userId` run command `name` on this channel (gateway §6.4)?
 *   - admins: anything.
 *   - non-admins: blocked from `ADMIN_COMMANDS`, and — when `userAllowedCommands`
 *     is configured — limited to that allowlist (skills excluded; they route
 *     through the normal message path, not the command gate).
 */
export function commandAllowed(cfg: ChannelConfig, userId: string, name: string): boolean {
  if (isAdmin(cfg, userId)) return true;
  if (ADMIN_COMMANDS.has(name)) return false;
  const allow = cfg.userAllowedCommands;
  if (allow && allow.length > 0) return allow.includes(name);
  return true;
}
