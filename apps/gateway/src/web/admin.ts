/**
 * Gateway admin operations (the Web config panel's business logic, gateway §7).
 * Wraps the same on-disk stores the CLI uses — `ConfigStore` (providers /
 * aliases), the keychain (secrets), `gateway.json` (channels), and the Router —
 * so "configure from zero" via the browser writes exactly what `ea` would. Kept
 * UI-free and JSON-serializable so it can be unit-tested and driven by any
 * transport (the bundled HTTP server, or a test).
 */
import { randomUUID } from 'node:crypto';
import type { AgentHost, ModelAlias, ProviderConfig, ProviderKind } from '@enterprise-agent/agent-contract';
import { BUILTIN_PROVIDERS, type ConfigStore, type ProviderPreset } from '@enterprise-agent/agent';
import type { KeyStore } from '@enterprise-agent/agent';
import {
  loadGatewayConfig,
  saveGatewayConfig,
  type ChannelConfig,
} from '../config/gateway-config.js';
import type { GatewayPaths } from '../config/paths.js';
import { Router } from '../runtime/router.js';
import { ILinkClient, ILINK_DEFAULT_BASE } from '../channels/weixin-ilink.js';
import { completeWeixinLogin } from '../weixin/login.js';

const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'gateway'];
const CHANNEL_NAMES = new Set(['telegram', 'weixin', 'whatsapp']);
const ORCHESTRATOR_ALIAS = 'orchestrator';

/** The keychain ref a provider's API key is stored under (matches the CLI). */
export function providerKeyRef(id: string): string {
  return `${id}.key`;
}

/** A baseURL pointing at localhost needs no key (agent §2.6). */
export function isLocalBase(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    const h = new URL(baseURL).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

interface WeixinLoginSession {
  client: ILinkClient;
  qrcode: string;
  accountId?: string;
  baseURL?: string;
}

export interface AdminDeps {
  config: ConfigStore;
  keychain: KeyStore;
  host: AgentHost;
  paths: GatewayPaths;
}

export class GatewayAdmin {
  private readonly weixinLogins = new Map<string, WeixinLoginSession>();

  constructor(private readonly deps: AdminDeps) {}

  // -- aggregate state -----------------------------------------------------

  state(): unknown {
    const providers = this.deps.config.loadProviders();
    const aliases = this.deps.config.loadGlobalAliases();
    const orchestrator = aliases.find((a) => a.alias === ORCHESTRATOR_ALIAS)?.ref ?? null;
    const gw = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const router = new Router(this.deps.paths.routes);

    const providerViews = providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      baseURL: p.baseURL,
      enabled: p.enabled,
      hasKey: p.keyRef ? this.deps.keychain.get(p.keyRef) !== undefined : !isLocalBase(p.baseURL) ? false : true,
    }));

    const channelViews = gw.channels.map((c) => ({
      name: c.name,
      accountId: c.accountId,
      enabled: c.enabled !== false,
      baseURL: c.baseURL,
      approval: c.approval ?? 'reject',
      group: c.group,
      session: c.session ?? {},
      reset: c.reset,
      allowAdminFrom: c.allowAdminFrom,
      userAllowedCommands: c.userAllowedCommands,
      tokenRef: c.token?.keyRef,
      hasToken: c.token ? this.deps.keychain.get(c.token.keyRef) !== undefined : false,
    }));

    return {
      providers: providerViews,
      orchestrator,
      aliases,
      channels: channelViews,
      routes: router.entries(),
      presets: BUILTIN_PROVIDERS as ProviderPreset[],
      verbose: gw.verbose === true,
      ready: {
        core: providerViews.some((p) => p.enabled) && orchestrator !== null,
        channels: channelViews.filter((c) => c.enabled && c.hasToken).map((c) => c.name),
      },
    };
  }

  // -- providers & models (agent §2.6) -------------------------------------

  addProvider(input: { kind: string; id: string; baseURL?: string; key?: string }): void {
    const kind = input.kind as ProviderKind;
    if (!PROVIDER_KINDS.includes(kind)) throw new Error(`未知 kind：${input.kind}`);
    const id = (input.id ?? '').trim();
    if (!id) throw new Error('provider id 不能为空');
    if ((kind === 'openai-compatible' || kind === 'gateway') && !input.baseURL) {
      throw new Error(`${kind} 必须提供 baseURL（含版本前缀，如 …/v1）`);
    }
    const needKey = !isLocalBase(input.baseURL);
    const keyRef = providerKeyRef(id);
    if (needKey && input.key) this.deps.keychain.set(keyRef, input.key);

    const cfg: ProviderConfig = {
      id,
      kind,
      baseURL: input.baseURL || undefined,
      keyRef: needKey ? keyRef : undefined,
      enabled: true,
    };
    const providers = this.deps.config.loadProviders().filter((p) => p.id !== id);
    providers.push(cfg);
    this.deps.config.saveProviders(providers);
  }

  deleteProvider(id: string): void {
    const providers = this.deps.config.loadProviders();
    const target = providers.find((p) => p.id === id);
    if (target?.keyRef) this.deps.keychain.delete(target.keyRef);
    this.deps.config.saveProviders(providers.filter((p) => p.id !== id));
  }

  discoverModels(id: string, refresh = false): Promise<unknown> {
    return this.deps.host.listProviderModels(id, { refresh });
  }

  /** Bind the orchestrator alias → `provider:model` (agent §2.6). */
  setOrchestrator(ref: string): void {
    if (!ref.includes(':')) throw new Error(`模型 ref 须为 provider:model（收到 "${ref}"）`);
    const aliases = this.deps.config.loadGlobalAliases().filter((a: ModelAlias) => a.alias !== ORCHESTRATOR_ALIAS);
    aliases.push({ alias: ORCHESTRATOR_ALIAS, ref });
    this.deps.config.saveGlobalAliases(aliases);
  }

  // -- secrets (gateway §7) ------------------------------------------------

  setSecret(ref: string, value: string): void {
    if (!ref.trim()) throw new Error('keyRef 不能为空');
    if (!value) throw new Error('值不能为空');
    this.deps.keychain.set(ref.trim(), value);
  }

  checkSecret(ref: string): boolean {
    return this.deps.keychain.get(ref) !== undefined;
  }

  deleteSecret(ref: string): void {
    this.deps.keychain.delete(ref);
  }

  // -- channels (gateway §3 / §7) ------------------------------------------

  upsertChannel(channel: ChannelConfig): void {
    if (!CHANNEL_NAMES.has(channel.name)) {
      throw new Error(`未知通道类型：${channel.name}（telegram / weixin / whatsapp）`);
    }
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const idx = cfg.channels.findIndex(
      (c) => c.name === channel.name && (c.accountId ?? '') === (channel.accountId ?? ''),
    );
    if (idx >= 0) cfg.channels[idx] = channel;
    else cfg.channels.push(channel);
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  deleteChannel(name: string, accountId?: string): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    cfg.channels = cfg.channels.filter(
      (c) => !(c.name === name && (c.accountId ?? '') === (accountId ?? '')),
    );
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  /** Toggle a channel's enabled flag in place (gateway §7). */
  setChannelEnabled(name: string, accountId: string | undefined, enabled: boolean): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const c = cfg.channels.find((x) => x.name === name && (x.accountId ?? '') === (accountId ?? ''));
    if (!c) throw new Error(`通道不存在：${name}${accountId ? `(${accountId})` : ''}`);
    c.enabled = enabled;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  setVerbose(verbose: boolean): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    cfg.verbose = verbose;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  // -- routes (gateway §4) -------------------------------------------------

  deleteRoute(channel: string, conversationId: string): void {
    new Router(this.deps.paths.routes).unbind(channel, conversationId);
  }

  // -- WeChat iLink QR login (gateway §8.3) --------------------------------

  /** Begin a scan login; returns the QR for the browser to render + a poll id. */
  async startWeixinLogin(input: { baseURL?: string; accountId?: string }): Promise<{
    loginId: string;
    qrcode: string;
    qrcodeImg?: string;
  }> {
    const client = new ILinkClient({ baseURL: input.baseURL ?? ILINK_DEFAULT_BASE });
    const qr = await client.getBotQrcode(3);
    if (!qr.qrcode) throw new Error('iLink 未返回二维码（get_bot_qrcode）');
    const loginId = randomUUID();
    this.weixinLogins.set(loginId, {
      client,
      qrcode: qr.qrcode,
      accountId: input.accountId,
      baseURL: input.baseURL,
    });
    return { loginId, qrcode: qr.qrcode, qrcodeImg: qr.qrcode_img_content };
  }

  /** Poll a login; on `confirmed`, finalize (keychain + gateway.json) and return it. */
  async pollWeixinLogin(loginId: string): Promise<{ status: string; accountId?: string; keyRef?: string }> {
    const session = this.weixinLogins.get(loginId);
    if (!session) return { status: 'expired' };
    const status = await session.client.getQrcodeStatus(session.qrcode);
    if (status.status !== 'confirmed') return { status: status.status ?? 'pending' };

    const result = completeWeixinLogin(
      {
        keychain: this.deps.keychain,
        paths: this.deps.paths,
        accountId: session.accountId,
        baseURL: session.baseURL,
      },
      status,
    );
    this.weixinLogins.delete(loginId);
    return { status: 'confirmed', accountId: result.accountId, keyRef: result.keyRef };
  }
}
