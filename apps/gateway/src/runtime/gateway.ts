/**
 * GatewayRuntime (gateway §1 / §2). The resident multi-session headless host:
 * it constructs one `AgentHost` (via the CLI bootstrap — same on-disk truth),
 * builds a `ChannelAdapter` per configured channel, wires them into the shared
 * Dispatcher + Router, and supervises each channel with a circuit breaker
 * (§2.3). core is untouched — the gateway is "just another host" (§1).
 */
import type { AgentHost } from '@enterprise-agent/agent-contract';
import type { KeyStore } from '@enterprise-agent/agent';
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
import { identity } from '../render/markdown.js';
import { Dispatcher, type PlatformControl } from './dispatcher.js';
import { Router } from './router.js';

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
  log?: (line: string) => void;
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

  constructor(opts: GatewayRuntimeOptions) {
    this.host = opts.host;
    this.keychain = opts.keychain;
    this.config = opts.config;
    this.paths = createGatewayPaths(opts.root);
    this.log = opts.log ?? ((l) => process.stderr.write(l + '\n'));
    this.router = new Router(this.paths.routes);
    this.dispatcher = new Dispatcher({
      host: this.host,
      router: this.router,
      verbose: this.config.verbose,
      platform: this,
      onError: (err) => this.log(`[gateway] ${(err as Error).message}`),
    });
  }

  /** Build + start every enabled channel (gateway §2.3 startup). */
  async start(): Promise<void> {
    this.dispatcher.subscribe();
    const channels = enabledChannels(this.config);
    if (channels.length === 0) this.log('[gateway] gateway.json 中没有已启用的通道。');
    for (const cfg of channels) {
      try {
        const rec = this.buildChannel(cfg);
        this.records.set(rec.name, rec);
        this.dispatcher.registerChannel(rec.adapter, cfg, formatFor(rec.name));
        await this.startChannel(rec);
        this.log(`[gateway] 通道已启动：${rec.name}`);
      } catch (err) {
        this.log(`[gateway] 通道 '${cfg.name}' 启动失败：${(err as Error).message}`);
      }
    }
  }

  /** Stop all channels then dispose the host (gateway §2.3 shutdown). */
  async stop(): Promise<void> {
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

/** Per-channel formatter (gateway §5). Platform rendering now lives in each
 *  adapter's `send` (Telegram → HTML, WeChat → plain text), so the ChatRenderer
 *  passes Markdown through untouched and the adapter owns the final formatting. */
function formatFor(_name: string): (text: string) => string {
  return identity;
}
