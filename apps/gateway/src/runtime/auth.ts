/**
 * Authorization & privilege partitioning (gateway §6.4). Borrowed from Hermes'
 * admin/user split: a channel may restrict who can fire high-risk commands and
 * which commands a non-admin may run at all. The `userId` (gateway §3.2) is the
 * subject. Pure functions so the policy is unit-testable.
 */
import type { ChannelConfig } from '../config/gateway-config.js';
import { ADMIN_COMMANDS } from '../commands/slash.js';

/**
 * Is `userId` an admin on this channel? When `allowAdminFrom` is unset/empty a
 * DM is single-user (a personal assistant bot, the common §8 case) so the user is
 * admin. But in a GROUP, treating an empty allowlist as "everyone" would let any
 * member approve another member's high-risk action — so a group fails CLOSED: no
 * admin unless an explicit allowlist is configured. Pass `{ isGroup: true }` for a
 * non-private conversation.
 */
export function isAdmin(cfg: ChannelConfig, userId: string, opts: { isGroup?: boolean } = {}): boolean {
  const admins = cfg.allowAdminFrom;
  if (!admins || admins.length === 0) return !opts.isGroup;
  return admins.includes(userId);
}

/**
 * May `userId` run command `name` on this channel (gateway §6.4)?
 *   - admins: anything.
 *   - non-admins: blocked from `ADMIN_COMMANDS`, and — when `userAllowedCommands`
 *     is configured — limited to that allowlist (skills excluded; they route
 *     through the normal message path, not the command gate).
 */
export function commandAllowed(
  cfg: ChannelConfig,
  userId: string,
  name: string,
  opts: { isGroup?: boolean } = {},
): boolean {
  if (isAdmin(cfg, userId, opts)) return true;
  if (ADMIN_COMMANDS.has(name)) return false;
  const allow = cfg.userAllowedCommands;
  if (allow && allow.length > 0) return allow.includes(name);
  return true;
}
