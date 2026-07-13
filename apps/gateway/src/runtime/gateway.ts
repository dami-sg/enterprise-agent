/**
 * GatewayRuntime (gateway §1 / §2). The resident multi-session headless host:
 * it constructs one `AgentHost` (via the CLI bootstrap — same on-disk truth),
 * builds a `ChannelAdapter` per configured channel, wires them into the shared
 * Dispatcher + Router, and supervises each channel with a circuit breaker
 * (§2.3). core is untouched — the gateway is "just another host" (§1).
 */
import type { AgentHost, MemoryPort } from '@dami-sg/agent-contract';
import { NULL_LOGGER, type KeyStore, type Logger } from '@dami-sg/agent';
import type { ChannelAdapter, InboundMessage } from '../channels/adapter.js';
import { TelegramAdapter } from '../channels/telegram.js';
import { WeixinAdapter } from '../channels/weixin.js';
import { WhatsAppAdapter } from '../channels/whatsapp.js';
import { ILinkClient, ILINK_DEFAULT_BASE } from '../channels/weixin-ilink.js';
import { WeixinStateStore } from '../channels/weixin-state.js';
import {
  enabledChannels,
  resolveToken,
  type ChannelConfig,
  type GatewayConfig,
} from '../config/gateway-config.js';
import { createGatewayPaths, type GatewayPaths } from '../config/paths.js';
import { Dispatcher, type PlatformControl } from './dispatcher.js';
import { Router } from './router.js';
import { IdentityStore } from '../accounts/identity-store.js';
import { SessionStore } from '../accounts/session-store.js';
import { resolveImAuthMode } from '../accounts/auth-mode.js';
import { createSttProvider, type SttProvider } from '../stt/index.js';

/** Consecutive channel failures before the breaker auto-pauses it (gateway §2.3). */
const FAIL_THRESHOLD = 5;

type ChannelState = 'running' | 'paused' | 'stopped' | 'error';

interface ChannelRecord {
  name: string;
  config: ChannelConfig;
  adapter: ChannelAdapter;
  onInbound: (m: InboundMessage) => void;
  state: ChannelState;
  failures: number;
}

export interface GatewayRuntimeOptions {
  host: AgentHost;
  keychain: KeyStore;
  config: GatewayConfig;
  /** App data root (for routes.json + adapter state). Defaults like the CLI. */
  root?: string;
  /** The host's memory port (cross-channel-memory §4), for `/memories` /
   *  `/forget` governance (§5.4). Undefined when backend is 'none'. */
  memory?: MemoryPort;
  log?: (line: string) => void;
  /** Operational logger (observability §5/§6). When given, the dispatcher uses
   *  it for per-turn correlated lines; `log` defaults to `logger.info`. */
  logger?: Logger;
}

export class GatewayRuntime implements PlatformControl {
  private readonly host: AgentHost;
  private readonly keychain: KeyStore;
  private readonly config: GatewayConfig;
  private readonly paths: GatewayPaths;
  private readonly log: (line: string) => void;
  private readonly router: Router;
  private readonly dispatcher: Dispatcher;
  private readonly records = new Map<string, ChannelRecord>();
  /** IM ingress gate mode (§P3b): fail-closed `managed` unless overridden. */
  private readonly imAuthMode = resolveImAuthMode();

  constructor(opts: GatewayRuntimeOptions) {
    this.host = opts.host;
    this.keychain = opts.keychain;
    this.config = opts.config;
    this.paths = createGatewayPaths(opts.root);
    const logger = opts.logger ?? NULL_LOGGER;
    this.log = opts.log ?? ((l) => (opts.logger ? logger.info(l) : process.stderr.write(l + '\n')));
    this.router = new Router(this.paths.routes);
    // STT for inbound voice (multimodal §7); a bad config logs + degrades (voice
    // then just gets saved) rather than crashing the gateway.
    let stt: SttProvider | undefined;
    try {
      // Voice is transcribed by the active backend (else the first saved one);
      // none ⇒ STT off (voice gets saved instead).
      const list = this.config.stt ?? [];
      const active = list.find((s) => s.id === this.config.sttActive) ?? list[0];
      stt = createSttProvider(active, this.keychain);
      if (stt) this.log(`[gateway] STT 已启用：${stt.name}`);
    } catch (err) {
      this.log(`[gateway] STT 配置无效，语音将不转写：${(err as Error).message}`);
    }
    this.dispatcher = new Dispatcher({
      host: this.host,
      router: this.router,
      verbose: this.config.verbose,
      platform: this,
      stt,
      memory: opts.memory,
      // Cross-channel identity (cross-channel-memory §3): map a bound inbound
      // {channel, userId} → accountId so private-chat sessions get a per-account
      // memory namespace. Unbound/group ⇒ no namespace ⇒ no memory. Read fresh
      // (only on the new-session path) so bindings made by `ea-gateway account`
      // in another process take effect without a gateway restart.
      resolveAccount: (provider, userId) =>
        new IdentityStore(this.paths.identityDir).resolveAccount(provider, userId),
      // IM access gate (§P3b). Gateway-wide mode; IM channels are reachable from
      // the whole platform's user base no matter where this process runs, so the
      // gate fails CLOSED: default `managed` — an unbound private-chat user must
      // `/bind <key>` first. A personal/local deployment opts out explicitly via
      // EA_GATEWAY_AUTH_MODE=open. Stores read fresh so keys/bindings issued in
      // another process take effect without a restart.
      authMode: this.imAuthMode,
      resolveKey: (raw) => new SessionStore(this.paths.identityDir).resolve(raw),
      bindIdentity: (provider, userId, accountId) =>
        new IdentityStore(this.paths.identityDir).bind(provider, userId, accountId),
      onError: (err) => this.log(`[gateway] ${(err as Error).message}`),
      logger,
    });
  }

  /** Build + start every enabled channel (gateway §2.3 startup). */
  async start(): Promise<void> {
    this.log(
      this.imAuthMode === 'managed'
        ? '[gateway] IM 接入模式：managed（未绑定用户须先 /bind 访问秘钥；本地个人部署可设 EA_GATEWAY_AUTH_MODE=open 关闭）'
        : '[gateway] IM 接入模式：open（任何能触达机器人的用户均可直接使用，请确认这是有意为之）',
    );
    this.dispatcher.subscribe();
    // The gateway is the resident host, so it drives the schedule timer (§7 B.7):
    // due schedules (日报/周报/巡检) fire while the daemon is up.
    this.host.startScheduler();
    const channels = enabledChannels(this.config);
    if (channels.length === 0) this.log('[gateway] gateway.json 中没有已启用的通道。');
    for (const cfg of channels) {
      try {
        const rec = this.buildChannel(cfg);
        this.records.set(rec.name, rec);
        // A channel's own media config wins; else the gateway-wide default (§3.2).
        this.dispatcher.registerChannel(rec.adapter, { ...cfg, media: cfg.media ?? this.config.media });
        await this.startChannel(rec);
        this.log(`[gateway] 通道已启动：${rec.name}`);
      } catch (err) {
        this.log(`[gateway] 通道 '${cfg.name}' 启动失败：${(err as Error).message}`);
      }
    }
  }

  /** Stop all channels then dispose the host (gateway §2.3 shutdown). */
  async stop(): Promise<void> {
    this.host.stopScheduler();
    for (const rec of this.records.values()) {
      rec.state = 'stopped';
      await rec.adapter.stop().catch(() => {});
    }
    this.dispatcher.dispose();
  }

  // -- PlatformControl (`/platform`, gateway §6.2) -------------------------

  list(): Array<{ name: string; state: string }> {
    return [...this.records.values()].map((r) => ({ name: r.name, state: r.state }));
  }

  pause(name: string): void {
    const rec = this.records.get(name);
    if (!rec || rec.state === 'paused') return;
    rec.state = 'paused';
    void rec.adapter.stop().catch(() => {});
    this.log(`[gateway] 通道已暂停：${name}`);
  }

  async resume(name: string): Promise<void> {
    const rec = this.records.get(name);
    if (!rec || rec.state === 'running') return;
    rec.failures = 0;
    await this.startChannel(rec);
    this.log(`[gateway] 通道已恢复：${name}`);
  }

  // -- internals -----------------------------------------------------------

  private async startChannel(rec: ChannelRecord): Promise<void> {
    rec.state = 'running';
    await rec.adapter.start(rec.onInbound);
  }

  private buildChannel(cfg: ChannelConfig): ChannelRecord {
    const onError = (err: unknown): void => this.channelError(cfg.name, err);
    const adapter = this.buildAdapter(cfg, onError);
    const onInbound = (m: InboundMessage): void => {
      const rec = this.records.get(cfg.name);
      if (rec) rec.failures = 0; // a delivered message clears the breaker (§2.3)
      void this.dispatcher.handleInbound(cfg.name, m);
    };
    return { name: cfg.name, config: cfg, adapter, onInbound, state: 'stopped', failures: 0 };
  }

  private buildAdapter(cfg: ChannelConfig, onError: (err: unknown) => void): ChannelAdapter {
    switch (cfg.name) {
      case 'telegram': {
        const token = resolveToken(cfg, this.keychain);
        if (!token) throw new Error('telegram 通道缺少 token（配置 token.keyRef 并写入 keychain）。');
        return new TelegramAdapter({ token, pollTimeoutSec: cfg.pollTimeoutSec, onError });
      }
      case 'weixin': {
        const accountId = cfg.accountId ?? 'default';
        const token = resolveToken(cfg, this.keychain);
        if (!token) throw new Error('weixin 通道缺少 bot_token（先运行 `ea-gateway weixin login`）。');
        const client = new ILinkClient({ baseURL: cfg.baseURL ?? ILINK_DEFAULT_BASE, botToken: token });
        const state = new WeixinStateStore(this.paths, accountId);
        return new WeixinAdapter({
          client,
          state,
          accountId,
          group: cfg.group,
          onError,
          warn: (m) => this.log(`[gateway] ${m}`),
        });
      }
      case 'whatsapp':
        return new WhatsAppAdapter();
      default:
        throw new Error(`未知通道类型：${cfg.name}（支持 telegram / weixin / whatsapp）`);
    }
  }

  /** Circuit breaker (gateway §2.3): trip after repeated failures, pause channel. */
  private channelError(name: string, err: unknown): void {
    this.log(`[gateway] 通道 '${name}' 错误：${(err as Error).message}`);
    const rec = this.records.get(name);
    if (!rec || rec.state !== 'running') return;
    rec.failures += 1;
    if (rec.failures >= FAIL_THRESHOLD) {
      rec.state = 'error';
      void rec.adapter.stop().catch(() => {});
      this.log(
        `[gateway] 通道 '${name}' 连续失败 ${rec.failures} 次，已熔断暂停。用 \`/platform resume ${name}\` 恢复。`,
      );
    }
  }
}
