/**
 * Connection profiles + app settings (desktop-app §3.1). Profiles are plain
 * JSON under userData; remote bearer tokens are NEVER stored there — they are
 * encrypted with Electron `safeStorage` (OS keychain-backed) into a separate
 * tokens file, keyed by profile id. `encrypt`/`decrypt` are injected so tests
 * run without Electron.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, ConnectionProfile, ProfileInput } from '../shared/ipc.js';

interface StoreFile {
  profiles: Array<Omit<ConnectionProfile, 'hasToken'>>;
  activeId?: string;
  settings: AppSettings;
}

interface TokensFile {
  /** profileId → base64(encrypted bearer token). */
  tokens: Record<string, string>;
}

export interface ProfileStoreDeps {
  dir: string;
  encrypt: (plain: string) => Buffer;
  decrypt: (blob: Buffer) => string;
  newId?: () => string;
}

const DEFAULT_SETTINGS: AppSettings = { stopGatewayOnQuit: false, theme: 'system', language: 'system' };

export class ProfileStore {
  private readonly file: string;
  private readonly tokensFile: string;
  private readonly deps: ProfileStoreDeps;
  private store: StoreFile;
  private tokens: TokensFile;

  constructor(deps: ProfileStoreDeps) {
    this.deps = deps;
    this.file = join(deps.dir, 'profiles.json');
    this.tokensFile = join(deps.dir, 'profile-tokens.json');
    this.store = this.readJson<StoreFile>(this.file) ?? {
      // First run: a zero-config local profile (§3.1).
      profiles: [{ id: deps.newId?.() ?? randomUUID(), name: '本机', mode: 'local' }],
      settings: { ...DEFAULT_SETTINGS },
    };
    this.store.settings = { ...DEFAULT_SETTINGS, ...this.store.settings };
    if (!this.store.activeId || !this.store.profiles.some((p) => p.id === this.store.activeId)) {
      this.store.activeId = this.store.profiles[0]?.id;
    }
    this.tokens = this.readJson<TokensFile>(this.tokensFile) ?? { tokens: {} };
    this.persist();
  }

  list(): ConnectionProfile[] {
    return this.store.profiles.map((p) => ({ ...p, hasToken: !!this.tokens.tokens[p.id] }));
  }

  get(id: string): ConnectionProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  activeId(): string | undefined {
    return this.store.activeId;
  }

  active(): ConnectionProfile | undefined {
    return this.store.activeId ? this.get(this.store.activeId) : undefined;
  }

  setActive(id: string): void {
    if (!this.store.profiles.some((p) => p.id === id)) throw new Error(`未知 profile：${id}`);
    this.store.activeId = id;
    this.persist();
  }

  upsert(input: ProfileInput): ConnectionProfile {
    let normalized = input;
    if (normalized.mode === 'remote') {
      const url = (normalized.url ?? '').trim();
      if (!url) throw new Error('remote profile 需要 URL');
      assertRemoteUrl(url);
      normalized = { ...normalized, url };
    }
    const id = normalized.id || this.deps.newId?.() || randomUUID();
    const existing = this.store.profiles.findIndex((p) => p.id === id);
    const record = { ...normalized, id };
    if (existing >= 0) this.store.profiles[existing] = record;
    else this.store.profiles.push(record);
    this.persist();
    return { ...record, hasToken: !!this.tokens.tokens[id] };
  }

  remove(id: string): void {
    this.store.profiles = this.store.profiles.filter((p) => p.id !== id);
    delete this.tokens.tokens[id];
    if (this.store.activeId === id) this.store.activeId = this.store.profiles[0]?.id;
    this.persist();
  }

  /** Store (or clear, with null) a remote bearer key — encrypted at rest (§9.5). */
  setToken(id: string, token: string | null): void {
    if (!this.store.profiles.some((p) => p.id === id)) throw new Error(`未知 profile：${id}`);
    if (token === null || token === '') delete this.tokens.tokens[id];
    else this.tokens.tokens[id] = this.deps.encrypt(token).toString('base64');
    this.persist();
  }

  /** Main-process only — never exposed over IPC (§9.2). */
  token(id: string): string | undefined {
    const blob = this.tokens.tokens[id];
    if (!blob) return undefined;
    try {
      return this.deps.decrypt(Buffer.from(blob, 'base64'));
    } catch {
      return undefined; // OS keychain unavailable / foreign machine — treat as absent
    }
  }

  settings(): AppSettings {
    return { ...this.store.settings };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.store.settings = { ...this.store.settings, ...patch };
    this.persist();
    return this.settings();
  }

  private readJson<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.store, null, 2) + '\n');
    writeFileSync(this.tokensFile, JSON.stringify(this.tokens) + '\n', { mode: 0o600 });
  }
}

/** Non-loopback remote targets must be TLS (`wss://`), desktop-app §3.2. */
export function assertRemoteUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`URL 无效：${url}`);
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('remote URL 需为 ws:// 或 wss://');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
  if (u.protocol === 'ws:' && !loopback) throw new Error('非 loopback 地址必须使用 wss://（TLS）');
}
