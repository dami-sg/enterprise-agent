/**
 * Gateway admin operations (the Web config panel's business logic, gateway §7).
 * Wraps the same on-disk stores the CLI uses — `ConfigStore` (providers /
 * aliases), the keychain (secrets), `gateway.json` (channels), and the Router —
 * so "configure from zero" via the browser writes exactly what `ea` would. Kept
 * UI-free and JSON-serializable so it can be unit-tested and driven by any
 * transport (the bundled HTTP server, or a test).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentHost,
  McpServerConfig,
  ModelAlias,
  ProviderConfig,
  ProviderKind,
  UsageDimension,
} from '@enterprise-agent/agent-contract';
import { isLocalBase, providerKeyRef } from '@enterprise-agent/agent-contract';

// Re-exported so the gateway's public API surface (index.ts) is unchanged.
export { isLocalBase, providerKeyRef } from '@enterprise-agent/agent-contract';
import { BUILTIN_PROVIDERS, createPaths, type ConfigStore, type ProviderPreset } from '@enterprise-agent/agent';
import type { KeyStore } from '@enterprise-agent/agent';
import { SkillsStore, type SkillSummary } from './skills-store.js';
import { resolveBundledSkillsDir, listBundledSkills, type BundledSkill } from './bundled-skills.js';
import { AgentsStore, type AgentSummary } from './agents-store.js';
import { resolveBundledAgentsDir, listBundledAgents, type BundledAgent } from './bundled-agents.js';
import { SchedulesStore, type ScheduleSummary } from './schedules-store.js';
import {
  loadGatewayConfig,
  saveGatewayConfig,
  type ChannelConfig,
  type ChannelSessionConfig,
  type GatewayConfig,
  type MediaConfig,
  type SttConfig,
} from '../config/gateway-config.js';
import type { GatewayPaths } from '../config/paths.js';
import { Router } from '../runtime/router.js';
import { IdentityStore } from '../accounts/identity-store.js';
import { SessionStore } from '../accounts/session-store.js';
import { GatewayProcessManager, type GatewayStatus } from '../runtime/gateway-process.js';
import { ILinkClient, ILINK_DEFAULT_BASE } from '../channels/weixin-ilink.js';
import { completeWeixinLogin } from '../weixin/login.js';

const PROVIDER_KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'openai-compatible', 'gateway'];
// Only channels with a working adapter are configurable via the admin surface.
// WhatsApp exists as a placeholder adapter (gateway §10 P2, webhook-only) whose
// start() throws — accepting it here would let the panel persist a channel that
// fails loudly at boot. Add it back once the adapter is implemented.
const CHANNEL_NAMES = new Set(['telegram', 'weixin']);
const EXECUTION_MODES = new Set(['ask', 'auto', 'plan', 'full']);
const ORCHESTRATOR_ALIAS = 'orchestrator';

/** A valid `ChannelConfig.approval` spec (mirrors the CLI's parseApprovePolicy). */
function isApprovalSpec(spec: string): boolean {
  return (
    spec === 'reject' ||
    spec === 'auto:once' ||
    spec === 'auto:session' ||
    spec === 'auto:task' ||
    spec.startsWith('policy:')
  );
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
  /** Gateway process controller; defaults to a real PID-file manager (tests inject). */
  process?: GatewayProcessManager;
  /** Bundled (vendored) skills dir; defaults to the shipped one (tests inject). */
  bundledSkillsDir?: string;
  /** Bundled (vendored) agents dir; defaults to the shipped one (tests inject). */
  bundledAgentsDir?: string;
}

export class GatewayAdmin {
  private readonly weixinLogins = new Map<string, WeixinLoginSession>();
  private readonly proc: GatewayProcessManager;
  private readonly skills: SkillsStore;
  private readonly bundledSkillsDir?: string;
  private readonly agents: AgentsStore;
  private readonly bundledAgentsDir?: string;
  private readonly schedules: SchedulesStore;

  constructor(private readonly deps: AdminDeps) {
    this.proc =
      deps.process ?? new GatewayProcessManager({ paths: deps.paths, root: deps.paths.root });
    // Global skills dir (same on-disk layout the agent discovers): <root>/skills.
    this.skills = new SkillsStore(createPaths(deps.paths.root).skills);
    this.bundledSkillsDir = deps.bundledSkillsDir ?? resolveBundledSkillsDir();
    // Global agents dir (same on-disk layout the agent discovers): <root>/agents.
    this.agents = new AgentsStore(createPaths(deps.paths.root).agents);
    this.bundledAgentsDir = deps.bundledAgentsDir ?? resolveBundledAgentsDir();
    // Global schedules dir (same on-disk layout the agent discovers): <root>/schedules.
    this.schedules = new SchedulesStore(createPaths(deps.paths.root).schedules);
  }

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
      stt: {
        active: gw.sttActive ?? '',
        entries: (gw.stt ?? []).map((s) => ({
          id: s.id ?? s.provider ?? '',
          provider: s.provider,
          model: s.model,
          baseURL: s.baseURL,
          language: s.language,
          responseFormat: s.responseFormat,
          hasKey: s.apiKey ? this.deps.keychain.get(s.apiKey.keyRef) !== undefined : false,
        })),
      },
      media: gw.media ?? {},
      mcp: this.deps.config.listMcpServers(),
      skills: this.skills.list(),
      bundledSkills: this.listBundledSkills(),
      agents: this.agents.list(),
      bundledAgents: this.listBundledAgents(),
      schedules: this.schedules.list(),
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

  /** Multi-dimensional usage rollup for the admin panel (agent §2.7). `by` is a
   *  comma-separated list of ledger dimensions; `from`/`to` are epoch ms. */
  usage(opts: { by?: string; from?: string; to?: string; category?: string; model?: string }): Promise<unknown> {
    const allowed = new Set(['sessionId', 'runId', 'agentId', 'modelRef', 'provider', 'category', 'entryId', 'hour', 'day', 'month']);
    const groupBy = (opts.by ?? 'day')
      .split(',')
      .map((s) => s.trim())
      .filter((d): d is UsageDimension => allowed.has(d));
    const num = (s?: string): number | undefined => (s && /^\d+$/.test(s) ? Number(s) : undefined);
    return this.deps.host.queryUsage({
      groupBy: groupBy.length ? groupBy : ['day'],
      from: num(opts.from),
      to: num(opts.to),
      filter: {
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.model ? { modelRef: opts.model } : {}),
      },
    });
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
      throw new Error(`未知通道类型：${channel.name}（telegram / weixin）`);
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

  /**
   * Edit an existing channel's execution mode and/or approval policy in place
   * (gateway §7), preserving every other field — token, reset, admins, workspace.
   * This is the targeted per-row edit the Web panel exposes; full re-config still
   * goes through `upsertChannel`.
   */
  updateChannelPolicy(
    name: string,
    accountId: string | undefined,
    patch: { executionMode?: string; approval?: string },
  ): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const c = cfg.channels.find((x) => x.name === name && (x.accountId ?? '') === (accountId ?? ''));
    if (!c) throw new Error(`通道不存在：${name}${accountId ? `(${accountId})` : ''}`);
    if (patch.executionMode !== undefined) {
      if (!EXECUTION_MODES.has(patch.executionMode)) {
        throw new Error(`未知执行模式：${patch.executionMode}（ask / auto / plan / full）`);
      }
      c.session = {
        ...(c.session ?? {}),
        executionMode: patch.executionMode as ChannelSessionConfig['executionMode'],
      };
    }
    if (patch.approval !== undefined) {
      if (!isApprovalSpec(patch.approval)) {
        throw new Error(`未知审批策略：${patch.approval}（reject / auto:once / auto:session / policy:<file>）`);
      }
      c.approval = patch.approval;
    }
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  setVerbose(verbose: boolean): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    cfg.verbose = verbose;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }


  /**
   * Add or update one STT backend in `gateway.json`'s `stt` list (multimodal §7),
   * keyed by `id` (defaults to `provider`). The API key goes to the keychain under
   * `stt.<id>.key` (only the ref is written to config); leaving the key blank
   * preserves the stored one. The first backend saved becomes active. Takes effect
   * on the next gateway restart.
   */
  setStt(input: { id?: string; provider?: string; model?: string; baseURL?: string; apiKey?: string; language?: string }): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const provider = (input.provider ?? '').trim();
    const id = ((input.id ?? '').trim() || provider).trim();
    if (!id) throw new Error('stt: 需要提供 id 或 provider');
    const list = cfg.stt ?? [];
    const existing = list.find((s) => (s.id ?? s.provider) === id);
    const next: SttConfig = { id, provider: provider || existing?.provider };
    if (input.model?.trim()) next.model = input.model.trim();
    if (input.baseURL?.trim()) next.baseURL = input.baseURL.trim();
    if (input.language?.trim()) next.language = input.language.trim();
    const key = input.apiKey?.trim();
    if (key) {
      const ref = `stt.${id}.key`;
      this.deps.keychain.set(ref, key);
      next.apiKey = { keyRef: ref };
    } else if (existing?.apiKey) {
      next.apiKey = existing.apiKey; // keep the existing key when the field is left blank
    }
    cfg.stt = existing ? list.map((s) => ((s.id ?? s.provider) === id ? next : s)) : [...list, next];
    if (!cfg.sttActive || !cfg.stt.some((s) => s.id === cfg.sttActive)) cfg.sttActive = id;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  /** Remove one STT backend (and its keychain entry). Reassigns the active id when
   *  the removed one was active; clears STT entirely when the list empties. */
  deleteStt(id: string): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const removed = (cfg.stt ?? []).find((s) => (s.id ?? s.provider) === id);
    if (removed?.apiKey) this.deps.keychain.delete(removed.apiKey.keyRef);
    const list = (cfg.stt ?? []).filter((s) => (s.id ?? s.provider) !== id);
    if (list.length) {
      cfg.stt = list;
      if (cfg.sttActive === id) cfg.sttActive = list[0]!.id;
    } else {
      delete cfg.stt;
      delete cfg.sttActive;
    }
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  /** Pick which saved STT backend transcribes voice (multimodal §7). */
  setSttActive(id: string): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    if (!(cfg.stt ?? []).some((s) => (s.id ?? s.provider) === id)) throw new Error(`stt: 未知配置 '${id}'`);
    cfg.sttActive = id;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  // -- media / multimodal (multimodal §3.2) --------------------------------

  /** Orchestrator input modalities (multimodal §3.1) — drives which passthrough
   *  options the panel shows. Unions the detected model capabilities with the
   *  operator's manual `media.modalities` declaration, so a declared-multimodal
   *  model the catalog can't confirm still shows as supported. */
  async modelModalities(): Promise<{ image: boolean; pdf: boolean; audio: boolean }> {
    const caps = await this.deps.host.modelCapabilities().catch(() => [] as string[]);
    // Only the image declaration augments detection; pdf/audio reflect real caps
    // (their inline passthrough isn't transport-portable, so we never claim them).
    const declaredImage = !!loadGatewayConfig(this.deps.paths.gatewayConfig).media?.modalities?.image;
    return {
      image: caps.includes('image') || declaredImage,
      pdf: caps.includes('pdf'),
      audio: caps.includes('audio'),
    };
  }

  /** Write the gateway-wide `media` block (multimodal §3.2). Empty input clears it.
   *  `modImage` declares the model accepts images when auto-detection is wrong.
   *  (Only image is declarable — PDF/audio inline passthrough isn't transport-
   *  portable; use `pdf: 'agent'`/`'auto'` to route PDFs to the agent instead.) */
  setMedia(input: { image?: string; pdf?: string; documents?: string; modImage?: boolean }): void {
    const cfg = loadGatewayConfig(this.deps.paths.gatewayConfig);
    const next: MediaConfig = {};
    if (input.image) next.image = input.image as MediaConfig['image'];
    if (input.pdf) next.pdf = input.pdf as MediaConfig['pdf'];
    if (input.documents) next.documents = input.documents as MediaConfig['documents'];
    if (input.modImage) next.modalities = { image: true };
    if (Object.keys(next).length === 0) delete cfg.media;
    else cfg.media = next;
    saveGatewayConfig(this.deps.paths.gatewayConfig, cfg);
  }

  // -- gateway process (gateway §7/§10) ------------------------------------

  /** Running / stopped / error, from the PID file (whoever started the gateway).
   *  When running, flags `stale` if any config surface changed after it started
   *  (MCP / skills / channels / providers) — a restart will apply those (§7). */
  gatewayStatus(): GatewayStatus {
    const st = this.proc.status();
    if (st.state === 'running' && st.startedAt) {
      return { ...st, stale: this.lastConfigChangeMs() > st.startedAt };
    }
    return st;
  }

  /** Newest mtime across the config the panel edits (gateway.json, providers,
   *  aliases, mcp/*, skills/<name>/SKILL.md[.disabled]). 0 if nothing exists. */
  private lastConfigChangeMs(): number {
    const agent = createPaths(this.deps.paths.root);
    let max = 0;
    const stat = (f: string): void => {
      try {
        max = Math.max(max, statSync(f).mtimeMs);
      } catch {
        /* missing — ignore */
      }
    };
    for (const f of [this.deps.paths.gatewayConfig, agent.providers, agent.aliases]) stat(f);
    stat(agent.mcp);
    if (existsSync(agent.mcp)) for (const f of readdirSync(agent.mcp)) stat(join(agent.mcp, f));
    stat(agent.skills);
    if (existsSync(agent.skills)) {
      for (const d of readdirSync(agent.skills)) {
        const sd = join(agent.skills, d);
        stat(sd);
        stat(join(sd, 'SKILL.md'));
        stat(join(sd, 'SKILL.md.disabled'));
      }
    }
    return max;
  }

  /** Spawn the resident gateway (no-op if already running). */
  startGateway(): GatewayStatus {
    return this.proc.start();
  }

  /** Signal the resident gateway to stop. */
  stopGateway(): GatewayStatus {
    return this.proc.stop();
  }

  /** Stop then start the resident gateway. */
  restartGateway(): GatewayStatus {
    return this.proc.restart();
  }

  // -- MCP servers (agent §2.7) --------------------------------------------

  listMcp(): McpServerConfig[] {
    return this.deps.config.listMcpServers();
  }

  /** Add or update a global MCP server. Merges over any existing entry so fields
   *  the form doesn't carry (e.g. `headers`) survive; switching transport drops
   *  the now-irrelevant fields. */
  saveMcp(cfg: McpServerConfig): void {
    if (!cfg || typeof cfg.name !== 'string' || !cfg.name.trim()) throw new Error('缺少 name');
    const transport = cfg.transport;
    if (transport !== 'stdio' && transport !== 'sse' && transport !== 'http') {
      throw new Error('transport 必须是 stdio / sse / http');
    }
    if (transport === 'stdio' && !cfg.command) throw new Error('stdio 传输需要 command');
    if ((transport === 'sse' || transport === 'http') && !cfg.url) throw new Error(`${transport} 传输需要 url`);
    const existing = this.deps.config.listMcpServers().find((s) => s.name === cfg.name);
    const merged: McpServerConfig = { ...existing, ...cfg, enabled: cfg.enabled !== false };
    if (transport === 'stdio') {
      delete merged.url;
      delete merged.headers;
    } else {
      delete merged.command;
      delete merged.args;
    }
    this.deps.config.saveMcpServer(merged); // assertSafeServerName guards the name
  }

  deleteMcp(name: string): void {
    this.deps.config.removeMcpServer(name);
  }

  setMcpEnabled(name: string, enabled: boolean): void {
    const cur = this.deps.config.listMcpServers().find((s) => s.name === name);
    if (!cur) throw new Error(`MCP server 不存在：${name}`);
    this.deps.config.saveMcpServer({ ...cur, enabled });
  }

  // -- skills (agent §2.4) -------------------------------------------------

  listSkills(): SkillSummary[] {
    return this.skills.list();
  }

  /** Built-in (vendored) skills shipped with the gateway, each flagged whether
   *  it's already installed into the active skills dir (gateway §7). */
  listBundledSkills(): Array<BundledSkill & { installed: boolean }> {
    const installed = new Set(this.skills.list().map((s) => s.dir));
    return listBundledSkills(this.bundledSkillsDir).map((b) => ({ ...b, installed: installed.has(b.dir) }));
  }

  /** Copy a built-in skill into the active skills dir (restart to discover). */
  installBundledSkill(dir: string): SkillSummary {
    if (!this.bundledSkillsDir) throw new Error('内置技能不可用（未随网关打包）');
    if (!listBundledSkills(this.bundledSkillsDir).some((b) => b.dir === dir)) {
      throw new Error(`未知内置技能：${dir}`);
    }
    return this.skills.installFrom(this.bundledSkillsDir, dir);
  }

  getSkill(dir: string): { content: string } {
    return { content: this.skills.read(dir) };
  }

  /** Create / edit a single-file skill (`dir` set ⇒ edit that folder). */
  saveSkillFile(content: string, dir?: string): SkillSummary {
    return this.skills.saveFile(content, dir);
  }

  /** Unpack a base64-encoded skill zip into the skills dir. */
  addSkillZip(base64: string): SkillSummary {
    if (!base64) throw new Error('缺少 zip 内容');
    return this.skills.addZip(Buffer.from(base64, 'base64'));
  }

  setSkillEnabled(dir: string, enabled: boolean): void {
    this.skills.setEnabled(dir, enabled);
  }

  deleteSkill(dir: string): void {
    this.skills.remove(dir);
  }

  // -- agents (declarative sub-agents, agent §2.3) -------------------------

  listAgents(): AgentSummary[] {
    return this.agents.list();
  }

  /** Built-in (vendored) agents shipped with the gateway, each flagged whether
   *  it's already installed into the active agents dir. */
  listBundledAgents(): Array<BundledAgent & { installed: boolean }> {
    const installed = new Set(this.agents.list().map((a) => a.dir));
    return listBundledAgents(this.bundledAgentsDir).map((b) => ({ ...b, installed: installed.has(b.dir) }));
  }

  /** Copy a built-in agent into the active agents dir (restart to discover). */
  installBundledAgent(dir: string): AgentSummary {
    if (!this.bundledAgentsDir) throw new Error('内置 agent 不可用（未随网关打包）');
    if (!listBundledAgents(this.bundledAgentsDir).some((b) => b.dir === dir)) {
      throw new Error(`未知内置 agent：${dir}`);
    }
    return this.agents.installFrom(this.bundledAgentsDir, dir);
  }

  getAgent(dir: string): { content: string } {
    return { content: this.agents.read(dir) };
  }

  /** Create / edit a single-file agent (`dir` set ⇒ edit that folder). */
  saveAgentFile(content: string, dir?: string): AgentSummary {
    return this.agents.saveFile(content, dir);
  }

  /** Unpack a base64-encoded agent zip into the agents dir. */
  addAgentZip(base64: string): AgentSummary {
    if (!base64) throw new Error('缺少 zip 内容');
    return this.agents.addZip(Buffer.from(base64, 'base64'));
  }

  setAgentEnabled(dir: string, enabled: boolean): void {
    this.agents.setEnabled(dir, enabled);
  }

  deleteAgent(dir: string): void {
    this.agents.remove(dir);
  }

  // -- schedules (§7 定时编排) ---------------------------------------------

  listSchedules(): ScheduleSummary[] {
    return this.schedules.list();
  }

  getSchedule(dir: string): { content: string } {
    return { content: this.schedules.read(dir) };
  }

  /** Create / edit a single-file schedule (`dir` set ⇒ edit that folder). */
  saveScheduleFile(content: string, dir?: string): ScheduleSummary {
    return this.schedules.saveFile(content, dir);
  }

  setScheduleEnabled(dir: string, enabled: boolean): void {
    this.schedules.setEnabled(dir, enabled);
  }

  deleteSchedule(dir: string): void {
    this.schedules.remove(dir);
  }

  /** Fire a schedule now via the host (§7); the folder name is the schedule name. */
  async runScheduleNow(name: string): Promise<{ sessionId: string; runId: string; status: 'done' | 'error' }> {
    return this.deps.host.runScheduleNow(name);
  }

  // -- routes (gateway §4) -------------------------------------------------

  deleteRoute(channel: string, conversationId: string): void {
    new Router(this.deps.paths.routes).unbind(channel, conversationId);
  }

  // -- accounts & access keys (gateway-consolidation §P3d) -----------------

  /** Accounts with their bound channel identities, for the panel's Access tab. */
  listAccounts(): Array<{
    accountId: string;
    displayName?: string;
    createdAt: number;
    identities: Array<{ provider: string; providerUserId: string }>;
  }> {
    const store = new IdentityStore(this.deps.paths.identityDir);
    return store.listAccounts().map((a) => ({
      accountId: a.accountId,
      displayName: a.displayName,
      createdAt: a.createdAt,
      identities: store
        .listIdentities(a.accountId)
        .map((i) => ({ provider: i.provider, providerUserId: i.providerUserId })),
    }));
  }

  /** Create an account; returns its id. */
  createAccount(displayName?: string): { accountId: string } {
    const a = new IdentityStore(this.deps.paths.identityDir).createAccount({
      displayName: displayName?.trim() || undefined,
    });
    return { accountId: a.accountId };
  }

  /** Issue an access key (a session token) for an account. Returns the RAW key
   *  once — only its hash is stored. The user presents it to `/rpc` (Bearer) or
   *  IM (`/bind <key>`). Default TTL 30 days. */
  issueAccessKey(accountId: string, ttlDays?: number): { token: string } {
    if (!new IdentityStore(this.deps.paths.identityDir).getAccount(accountId)) {
      throw new Error(`未知账号：${accountId}`);
    }
    const ttl = ttlDays && ttlDays > 0 ? ttlDays : 30;
    const { token } = new SessionStore(this.deps.paths.identityDir).issue(accountId, {
      ttlMs: ttl * 24 * 60 * 60_000,
    });
    return { token };
  }

  /**
   * Full "logout everywhere" / de-provision for an account: revoke every access key
   * AND unbind every IM channel identity. Revoking keys alone does NOT cut IM access,
   * because `/bind` persists a `{channel,userId}→accountId` identity that the IM gate
   * checks (not the key) — so a de-provision has to drop both. Returns both counts.
   */
  revokeAccessKeys(accountId: string): { revoked: number; unbound: number } {
    const revoked = new SessionStore(this.deps.paths.identityDir).revokeAllForAccount(accountId);
    const unbound = new IdentityStore(this.deps.paths.identityDir).unbindAllForAccount(accountId);
    return { revoked, unbound };
  }

  /** Unbind a channel identity so that user can no longer talk until re-bound. */
  unbindIdentity(provider: string, providerUserId: string): { ok: boolean } {
    return { ok: new IdentityStore(this.deps.paths.identityDir).unbind(provider, providerUserId) };
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
