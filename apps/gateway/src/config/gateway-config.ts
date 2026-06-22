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

/**
 * Per-channel media handling (multimodal §3.2). Each strategy is only honored
 * when the orchestrator model supports the modality — otherwise the Dispatcher
 * degrades (§11). Absent fields use the defaults below.
 */
export interface MediaConfig {
  /** Image: `passthrough` to a vision model / `describe` (B, not yet) / `off` /
   *  `auto` (passthrough when vision-capable, else save). Default `auto`. */
  image?: 'passthrough' | 'describe' | 'off' | 'auto';
  /** PDF: `agent` (save, Route C) / `passthrough` (A, to a pdf-capable model) /
   *  `extract` (B, not yet). Default `agent`. */
  pdf?: 'agent' | 'passthrough' | 'extract';
  /** Other documents: `agent` (save) / `extract` (B, not yet). Default `agent`. */
  documents?: 'agent' | 'extract';
}

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
  /** Media handling: image/PDF passthrough vs save/describe (multimodal §3.2). */
  media?: MediaConfig;
  /**
   * File-boundary isolation across users (gateway §4.2). With a `session.workingDir`:
   *   - `per-user` (default) → each conversation gets its own subdirectory under
   *     it, so different accounts can't see each other's files.
   *   - `shared` → every conversation shares the one base directory.
   * With NO workingDir, core's per-session scratch already isolates by session.
   */
  workspace?: 'per-user' | 'shared';
}

/**
 * One saved speech-to-text backend (multimodal §7). `provider` picks a preset
 * (stepfun / openai) or any OpenAI-compatible `/audio/transcriptions` endpoint
 * via `baseURL`+`model`. The API key lives in the keychain (only a `keyRef`
 * here). Multiple backends can be saved (see `GatewayConfig.stt`); `sttActive`
 * names the one that actually transcribes voice — like a provider list with one
 * bound orchestrator. Absent / none active ⇒ voice is just saved (multimodal §8).
 */
export interface SttConfig {
  /** Unique key / label among saved backends (e.g. 'openai', 'my-asr'). Always
   *  set when persisted; defaults to `provider` when the form omits it. */
  id?: string;
  /** 'stepfun' | 'openai' | any id for an openai-compatible endpoint. */
  provider?: string;
  /** Transcription model; defaults from the provider preset. */
  model?: string;
  /** API base incl. version; defaults from the provider preset. */
  baseURL?: string;
  apiKey?: KeyRef;
  responseFormat?: 'json' | 'text';
  /** Language hint (e.g. 'zh'). */
  language?: string;
}

export interface GatewayConfig {
  channels: ChannelConfig[];
  /** Stream the full tool/sub-agent trajectory into chat (gateway §5). Default false. */
  verbose?: boolean;
  /** Saved speech-to-text backends for inbound voice (multimodal §7). Off when empty. */
  stt?: SttConfig[];
  /** Id of the active STT backend (the one that transcribes voice). */
  sttActive?: string;
  /** Default media handling (multimodal §3.2); a channel's own `media` overrides it. */
  media?: MediaConfig;
}

/**
 * Saved STT backends. Tolerates the legacy single-object `stt` form (pre-list)
 * by wrapping it as a one-entry list, and back-fills a missing `id` from
 * `provider` so older configs keep working after the list migration.
 */
function parseSttList(raw: unknown): SttConfig[] | undefined {
  const norm = (s: SttConfig): SttConfig => ({ ...s, id: (s.id ?? s.provider ?? 'asr').trim() || 'asr' });
  if (Array.isArray(raw)) {
    const list = raw.filter((s): s is SttConfig => !!s && typeof s === 'object').map(norm);
    return list.length ? list : undefined;
  }
  if (raw && typeof raw === 'object') return [norm(raw as SttConfig)];
  return undefined;
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
  const stt = parseSttList(obj['stt']);
  const sttActive =
    typeof obj['sttActive'] === 'string' && stt?.some((s) => s.id === obj['sttActive'])
      ? (obj['sttActive'] as string)
      : stt?.[0]?.id;
  const media =
    typeof obj['media'] === 'object' && obj['media'] !== null ? (obj['media'] as MediaConfig) : undefined;
  return { channels, verbose: obj['verbose'] === true, stt, sttActive, media };
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
