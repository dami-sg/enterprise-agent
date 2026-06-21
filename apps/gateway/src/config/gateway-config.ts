/**
 * Gateway config (gateway §7). Same school as mcp / providers (agent §5.2):
 * the file describes channels declaratively, secrets are stored only as a
 * `{ keyRef }` into the OS keychain — never plaintext. Token resolution reuses
 * the same keychain backend the CLI writes with (`ea secret`-style flows).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyStore } from '@enterprise-agent/agent';
import type { ScopedConfig } from '@enterprise-agent/agent-contract';

/** A keychain reference (gateway §7) — the only secret shape allowed in config. */
export interface KeyRef {
  keyRef: string;
}

export type ResetMode = 'daily' | 'idle' | 'command';

/** Session reset policy (gateway §4.3). */
export interface ResetConfig {
  mode: ResetMode;
  /** `daily`: local wall-clock HH:MM, default '04:00'. */
  at?: string;
  /** `idle`: minutes of silence before the next message starts fresh, default 1440. */
  idleMinutes?: number;
}

/**
 * The scoped config a channel injects into every session it creates (gateway
 * §4.2) — reuses core's `ScopedConfig` wholesale, plus an optional working
 * directory (the file boundary, agent §4). No new isolation mechanism.
 */
export type ChannelSessionConfig = ScopedConfig & { workingDir?: string };

/** One configured platform channel (gateway §7). */
export interface ChannelConfig {
  name: string; // 'telegram' | 'weixin' | 'whatsapp'
  enabled?: boolean;
  /** Bot token — resolved from keychain at startup (gateway §7). */
  token?: KeyRef;
  /** WeChat iLink base URL from QR login (§8.3). */
  baseURL?: string;
  /** WeChat account id (`bot-xxx`), keys per-account state (§8.5). */
  accountId?: string;
  /** Per-channel scoped config injected into new sessions (§4.2). */
  session?: ChannelSessionConfig;
  /** Approval policy spec: `reject` | `auto:once` | `auto:session` | `policy:<file>` (§6.1). */
  approval?: string;
  /** Session reset policy (§4.3). */
  reset?: ResetConfig;
  /** WeChat group handling; iLink groups are basically unusable (§8.6). Default 'disabled'. */
  group?: 'disabled' | 'enabled';
  /** User ids permitted to run admin/high-risk commands (§6.4). Empty/unset = allow all. */
  allowAdminFrom?: string[];
  /** Commands non-admin users may run (§6.4). Unset = all; set = allowlist. */
  userAllowedCommands?: string[];
  /** Telegram poll timeout seconds (long-poll). Default 30. */
  pollTimeoutSec?: number;
}

export interface GatewayConfig {
  channels: ChannelConfig[];
  /** Stream the full tool/sub-agent trajectory into chat (gateway §5). Default false. */
  verbose?: boolean;
}

/** Read `gateway.json`; returns an empty config when absent (gateway §7). */
export function loadGatewayConfig(file: string): GatewayConfig {
  if (!existsSync(file)) return { channels: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`gateway.json 不是有效 JSON（${file}）：${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gateway.json 必须是一个对象（${file}）`);
  }
  const obj = parsed as Record<string, unknown>;
  const channels = Array.isArray(obj['channels']) ? (obj['channels'] as ChannelConfig[]) : [];
  return { channels, verbose: obj['verbose'] === true };
}

/** Persist `gateway.json` (used by `weixin login`, gateway §8.3). */
export function saveGatewayConfig(file: string, cfg: GatewayConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Resolve a channel's bot token from the keychain (gateway §7). Throws when a
 * `keyRef` is configured but absent — a misconfigured channel must fail loud at
 * startup, not silently poll with an empty token.
 */
export function resolveToken(cfg: ChannelConfig, keychain: KeyStore): string | undefined {
  if (!cfg.token) return undefined;
  const v = keychain.get(cfg.token.keyRef);
  if (v === undefined) {
    throw new Error(
      `通道 '${cfg.name}' 的 token keyRef='${cfg.token.keyRef}' 在 keychain 中不存在（用 \`ea secret set ${cfg.token.keyRef}\` 写入）。`,
    );
  }
  return v;
}

/** Channels that are enabled (default true when the flag is omitted). */
export function enabledChannels(cfg: GatewayConfig): ChannelConfig[] {
  return cfg.channels.filter((c) => c.enabled !== false);
}
