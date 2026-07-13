/**
 * Authorization & privilege partitioning (gateway §6.4). Borrowed from Hermes'
 * admin/user split: a channel may restrict who can fire high-risk commands and
 * which commands a non-admin may run at all. The `userId` (gateway §3.2) is the
 * subject. Pure functions so the policy is unit-testable.
 */
import type { ChannelConfig } from '../config/gateway-config.js';
import { ADMIN_COMMANDS, PLATFORM_ADMIN_COMMANDS } from '../commands/slash.js';

/** Authorization context: DM vs group, and whether the IM gate runs `managed`. */
export interface AuthOpts {
  /** Pass `true` for a non-private conversation. */
  isGroup?: boolean;
  /** Pass `true` when the gateway's IM auth mode is `managed` (multi-user). */
  managed?: boolean;
}

/**
 * Is `userId` a *conversation-scoped* admin on this channel? When
 * `allowAdminFrom` is unset/empty a DM is single-user within that conversation
 * (the caller can only see / act on their own runs), so the user is admin of it —
 * even in `managed` mode, where reaching this point already required a bound
 * access key. But in a GROUP, treating an empty allowlist as "everyone" would let
 * any member approve another member's high-risk action — so a group fails
 * CLOSED: no admin unless an explicit allowlist is configured.
 */
export function isAdmin(cfg: ChannelConfig, userId: string, opts: AuthOpts = {}): boolean {
  const admins = cfg.allowAdminFrom;
  if (!admins || admins.length === 0) return !opts.isGroup;
  return admins.includes(userId);
}

/**
 * Is `userId` a *deployment-level* admin — allowed to run verbs whose effect
 * crosses conversations (`PLATFORM_ADMIN_COMMANDS`, e.g. `/platform` pausing a
 * whole channel)? With an explicit allowlist this equals `isAdmin`. Without one,
 * the DM-implies-admin shortcut only holds in `open` mode (single-user personal
 * bot): a `managed` deployment is multi-user by definition, so one key-holder
 * must not be able to pause the channel for everyone — fail CLOSED until the
 * operator configures `allowAdminFrom`.
 */
export function isPlatformAdmin(cfg: ChannelConfig, userId: string, opts: AuthOpts = {}): boolean {
  const admins = cfg.allowAdminFrom;
  if (!admins || admins.length === 0) return !opts.isGroup && !opts.managed;
  return admins.includes(userId);
}

/**
 * May `userId` run command `name` on this channel (gateway §6.4)?
 *   - platform-wide verbs (`PLATFORM_ADMIN_COMMANDS`): deployment-level admins only.
 *   - conversation-scoped admins: everything else.
 *   - non-admins: blocked from `ADMIN_COMMANDS`, and — when `userAllowedCommands`
 *     is configured — limited to that allowlist (skills excluded; they route
 *     through the normal message path, not the command gate).
 */
export function commandAllowed(
  cfg: ChannelConfig,
  userId: string,
  name: string,
  opts: AuthOpts = {},
): boolean {
  if (PLATFORM_ADMIN_COMMANDS.has(name)) return isPlatformAdmin(cfg, userId, opts);
  if (isAdmin(cfg, userId, opts)) return true;
  if (ADMIN_COMMANDS.has(name)) return false;
  const allow = cfg.userAllowedCommands;
  if (allow && allow.length > 0) return allow.includes(name);
  return true;
}
