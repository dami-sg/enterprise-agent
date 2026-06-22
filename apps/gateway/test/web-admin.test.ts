/**
 * Web config panel admin logic (gateway §7). Drives GatewayAdmin against a real
 * ConfigStore (temp root) + in-memory keychain + a fake host, asserting the
 * "configure from zero" operations write the same on-disk truth the CLI does.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, createPaths } from '@enterprise-agent/agent';
import type { AgentHost, KeyStore } from '@enterprise-agent/agent';
import { GatewayAdmin, isLocalBase } from '../src/web/admin.js';
import { createGatewayPaths } from '../src/config/paths.js';
import { loadGatewayConfig } from '../src/config/gateway-config.js';
import { GatewayProcessManager, writeGatewayPid } from '../src/runtime/gateway-process.js';

class MemKeyStore implements KeyStore {
  private m = new Map<string, string>();
  get(ref: string): string | undefined {
    return this.m.get(ref);
  }
  set(ref: string, value: string): void {
    this.m.set(ref, value);
  }
  delete(ref: string): void {
    this.m.delete(ref);
  }
}

const fakeHost = {
  async listProviderModels(id: string) {
    return { providerId: id, models: [{ ref: `${id}:m1`, id: 'm1', hasMeta: true, source: 'static' }], fetchedAt: 0, cached: false };
  },
} as unknown as AgentHost;

let dir: string;
let admin: GatewayAdmin;
let keychain: MemKeyStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-admin-'));
  keychain = new MemKeyStore();
  admin = new GatewayAdmin({
    config: new ConfigStore(createPaths(dir)),
    keychain,
    host: fakeHost,
    paths: createGatewayPaths(dir),
  });
  return () => rmSync(dir, { recursive: true, force: true });
});

function state(): any {
  return admin.state();
}

describe('isLocalBase', () => {
  it('recognizes localhost endpoints', () => {
    expect(isLocalBase('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBase('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalBase('https://api.openai.com/v1')).toBe(false);
    expect(isLocalBase(undefined)).toBe(false);
  });
});

describe('providers & models', () => {
  it('adds a local provider (no key needed) and reports it ready', () => {
    admin.addProvider({ kind: 'openai-compatible', id: 'ollama', baseURL: 'http://localhost:11434/v1' });
    const s = state();
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]).toMatchObject({ id: 'ollama', hasKey: true });
  });

  it('adds a keyed provider → key lands in the keychain only', () => {
    admin.addProvider({ kind: 'anthropic', id: 'anthropic', key: 'sk-xyz' });
    expect(keychain.get('anthropic.key')).toBe('sk-xyz');
    expect(state().providers[0].hasKey).toBe(true);
  });

  it('rejects openai-compatible without a baseURL', () => {
    expect(() => admin.addProvider({ kind: 'openai-compatible', id: 'x' })).toThrow(/baseURL/);
  });

  it('discovers models and binds the orchestrator alias', async () => {
    admin.addProvider({ kind: 'openai-compatible', id: 'ollama', baseURL: 'http://localhost:11434/v1' });
    const models = (await admin.discoverModels('ollama')) as { models: Array<{ ref: string }> };
    expect(models.models[0]!.ref).toBe('ollama:m1');
    admin.setOrchestrator('ollama:m1');
    expect(state().orchestrator).toBe('ollama:m1');
    expect(state().ready.core).toBe(true);
  });

  it('deleting a provider also clears its key', () => {
    admin.addProvider({ kind: 'anthropic', id: 'anthropic', key: 'sk-xyz' });
    admin.deleteProvider('anthropic');
    expect(keychain.get('anthropic.key')).toBeUndefined();
    expect(state().providers).toHaveLength(0);
  });
});

describe('secrets & channels', () => {
  it('writes a token + channel; gateway.json stores only the keyRef', () => {
    admin.setSecret('telegram-bot-token', 'TKN');
    admin.upsertChannel({
      name: 'telegram',
      enabled: true,
      token: { keyRef: 'telegram-bot-token' },
      session: { executionMode: 'auto' },
    });
    const s = state();
    expect(s.channels).toEqual([expect.objectContaining({ name: 'telegram', hasToken: true })]);
    expect(s.ready.channels).toEqual(['telegram']);

    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(JSON.stringify(onDisk)).not.toContain('TKN'); // plaintext never in config
    expect(onDisk.channels[0]!.token).toEqual({ keyRef: 'telegram-bot-token' });
  });

  it('upsert replaces a same-name channel rather than duplicating', () => {
    admin.upsertChannel({ name: 'telegram', enabled: true, session: { executionMode: 'ask' } });
    admin.upsertChannel({ name: 'telegram', enabled: true, session: { executionMode: 'auto' } });
    const s = state();
    expect(s.channels).toHaveLength(1);
    expect(s.channels[0].session.executionMode).toBe('auto');
  });

  it('rejects an unknown channel type', () => {
    expect(() => admin.upsertChannel({ name: 'slack' } as never)).toThrow(/未知通道/);
  });

  it('updates an existing channel mode + approval in place, preserving other fields', () => {
    admin.setSecret('telegram-bot-token', 'TKN');
    admin.upsertChannel({
      name: 'telegram',
      enabled: true,
      token: { keyRef: 'telegram-bot-token' },
      session: { executionMode: 'ask', workingDir: '/srv/tg' },
      approval: 'reject',
      allowAdminFrom: ['42'],
    });
    admin.updateChannelPolicy('telegram', undefined, { executionMode: 'auto', approval: 'auto:session' });

    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    const c = onDisk.channels[0]!;
    expect(c.session?.executionMode).toBe('auto');
    expect(c.approval).toBe('auto:session');
    // Untouched fields survive the targeted edit.
    expect(c.session?.workingDir).toBe('/srv/tg');
    expect(c.token).toEqual({ keyRef: 'telegram-bot-token' });
    expect(c.allowAdminFrom).toEqual(['42']);
  });

  it('rejects an invalid mode / approval and an unknown channel', () => {
    admin.upsertChannel({ name: 'telegram', enabled: true, session: { executionMode: 'ask' } });
    expect(() => admin.updateChannelPolicy('telegram', undefined, { executionMode: 'turbo' })).toThrow(/执行模式/);
    expect(() => admin.updateChannelPolicy('telegram', undefined, { approval: 'maybe' })).toThrow(/审批/);
    expect(() => admin.updateChannelPolicy('nope', undefined, { approval: 'reject' })).toThrow(/通道不存在/);
  });

  it('toggles a channel enabled flag in place', () => {
    admin.upsertChannel({ name: 'telegram', enabled: true, session: { executionMode: 'ask' } });
    admin.setChannelEnabled('telegram', undefined, false);
    expect(state().channels[0].enabled).toBe(false);
    admin.setChannelEnabled('telegram', undefined, true);
    expect(state().channels[0].enabled).toBe(true);
  });

  it('check/delete secret', () => {
    admin.setSecret('r', 'v');
    expect(admin.checkSecret('r')).toBe(true);
    admin.deleteSecret('r');
    expect(admin.checkSecret('r')).toBe(false);
  });

  it('reports gateway process status via the injected manager', () => {
    const paths = createGatewayPaths(dir);
    let alive = false;
    const proc = new GatewayProcessManager({ paths, isAlive: () => alive });
    const a = new GatewayAdmin({ config: new ConfigStore(createPaths(dir)), keychain, host: fakeHost, paths, process: proc });
    expect(a.gatewayStatus().state).toBe('stopped');
    writeGatewayPid(paths, 4242, 1000);
    alive = true;
    expect(a.gatewayStatus()).toMatchObject({ state: 'running', pid: 4242 });
  });

  it('flags the running gateway as stale when config changed after it started', () => {
    const paths = createGatewayPaths(dir);
    const proc = new GatewayProcessManager({ paths, isAlive: () => true });
    const a = new GatewayAdmin({ config: new ConfigStore(createPaths(dir)), keychain, host: fakeHost, paths, process: proc });
    a.upsertChannel({ name: 'telegram', enabled: true, session: { executionMode: 'ask' } }); // writes gateway.json now

    writeGatewayPid(paths, 1, 1); // started at epoch 1 — well before the config write
    expect(a.gatewayStatus().stale).toBe(true);

    writeGatewayPid(paths, 1, Date.now() + 60_000); // started "after" any config change
    expect(a.gatewayStatus().stale).toBe(false);
  });

  it('adds / lists / enables / deletes an MCP server (ConfigStore-backed)', () => {
    admin.saveMcp({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], enabled: true } as never);
    let list = admin.listMcp();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'fs', transport: 'stdio', command: 'npx', enabled: true });

    admin.setMcpEnabled('fs', false);
    expect(admin.listMcp()[0]!.enabled).toBe(false);

    // Switching transport drops the now-irrelevant stdio fields.
    admin.saveMcp({ name: 'fs', transport: 'http', url: 'https://x/mcp', enabled: true } as never);
    expect(admin.listMcp()[0]).toMatchObject({ transport: 'http', url: 'https://x/mcp' });
    expect(admin.listMcp()[0]!.command).toBeUndefined();

    admin.deleteMcp('fs');
    expect(admin.listMcp()).toEqual([]);
  });

  it('rejects an MCP server missing its transport target', () => {
    expect(() => admin.saveMcp({ name: 'x', transport: 'stdio', enabled: true } as never)).toThrow(/command/);
    expect(() => admin.saveMcp({ name: 'x', transport: 'http', enabled: true } as never)).toThrow(/url/);
  });

  it('saves, lists, enables/disables, reads and deletes a single-file skill', () => {
    const md = '---\nname: Demo\ndescription: a demo\n---\nbody\n';
    const s = admin.saveSkillFile(md);
    expect(s).toMatchObject({ dir: 'demo', name: 'Demo', enabled: true });
    expect(admin.listSkills()).toEqual([{ dir: 'demo', name: 'Demo', description: 'a demo', enabled: true }]);
    expect(admin.getSkill('demo').content).toContain('body');

    admin.setSkillEnabled('demo', false);
    expect(admin.listSkills()[0]!.enabled).toBe(false);
    admin.setSkillEnabled('demo', true);
    expect(admin.listSkills()[0]!.enabled).toBe(true);

    admin.deleteSkill('demo');
    expect(admin.listSkills()).toEqual([]);
  });

  it('toggles verbose in gateway.json', () => {
    admin.setVerbose(true);
    expect(state().verbose).toBe(true);
  });
});

describe('ASR / STT config — list + active (multimodal §7)', () => {
  type SttState = { active: string; entries: Array<{ id: string; hasKey: boolean }> };

  it('defaults to an empty list with no active backend', () => {
    const s = state().stt as SttState;
    expect(s.active).toBe('');
    expect(s.entries).toEqual([]);
  });

  it('adds a backend (key in keychain only) and auto-activates the first', () => {
    admin.setStt({ provider: 'stepfun', apiKey: 'sk-asr', language: 'zh' });
    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(onDisk.stt).toEqual([{ id: 'stepfun', provider: 'stepfun', language: 'zh', apiKey: { keyRef: 'stt.stepfun.key' } }]);
    expect(onDisk.sttActive).toBe('stepfun'); // first saved becomes active
    expect(keychain.get('stt.stepfun.key')).toBe('sk-asr'); // plaintext only in keychain
    expect(JSON.stringify(onDisk)).not.toContain('sk-asr');
    const s = state().stt as SttState;
    expect(s.active).toBe('stepfun');
    expect(s.entries).toEqual([{ id: 'stepfun', provider: 'stepfun', model: undefined, baseURL: undefined, language: 'zh', responseFormat: undefined, hasKey: true }]);
  });

  it('lists multiple backends and switches the active one without re-activating on add', () => {
    admin.setStt({ provider: 'stepfun', apiKey: 'sk-1' });
    admin.setStt({ provider: 'openai', apiKey: 'sk-2' }); // second add must NOT steal active
    let onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect((onDisk.stt ?? []).map((s) => s.id)).toEqual(['stepfun', 'openai']);
    expect(onDisk.sttActive).toBe('stepfun');
    admin.setSttActive('openai');
    onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(onDisk.sttActive).toBe('openai');
    expect(() => admin.setSttActive('nope')).toThrow(/未知/);
  });

  it('supports two custom endpoints under distinct ids', () => {
    admin.setStt({ id: 'asr-a', provider: 'custom', baseURL: 'https://a/v1', model: 'm', apiKey: 'k-a' });
    admin.setStt({ id: 'asr-b', provider: 'custom', baseURL: 'https://b/v1', model: 'm', apiKey: 'k-b' });
    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect((onDisk.stt ?? []).map((s) => s.id)).toEqual(['asr-a', 'asr-b']);
    expect(keychain.get('stt.asr-a.key')).toBe('k-a');
    expect(keychain.get('stt.asr-b.key')).toBe('k-b');
  });

  it('keeps the stored key when an entry is re-saved with a blank key field', () => {
    admin.setStt({ provider: 'openai', apiKey: 'sk-1' });
    admin.setStt({ provider: 'openai', apiKey: '' }); // re-saved without re-entering the key
    expect(keychain.get('stt.openai.key')).toBe('sk-1');
    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(onDisk.stt).toHaveLength(1);
    expect(onDisk.stt![0]!.apiKey).toEqual({ keyRef: 'stt.openai.key' });
  });

  it('deletes a backend (and its key), reassigning active, then clears stt when empty', () => {
    admin.setStt({ provider: 'stepfun', apiKey: 'sk-1' });
    admin.setStt({ provider: 'openai', apiKey: 'sk-2' });
    admin.deleteStt('stepfun'); // the active one
    let onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect((onDisk.stt ?? []).map((s) => s.id)).toEqual(['openai']);
    expect(onDisk.sttActive).toBe('openai'); // reassigned to the survivor
    expect(keychain.get('stt.stepfun.key')).toBeUndefined(); // key dropped
    admin.deleteStt('openai');
    onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(onDisk.stt).toBeUndefined();
    expect(onDisk.sttActive).toBeUndefined();
  });
});

describe('media config + modalities (multimodal §3.2)', () => {
  it('writes the media block and reflects it in state', () => {
    admin.setMedia({ image: 'passthrough', pdf: 'agent' });
    const onDisk = loadGatewayConfig(createGatewayPaths(dir).gatewayConfig);
    expect(onDisk.media).toEqual({ image: 'passthrough', pdf: 'agent' });
    expect((state().media as { image: string }).image).toBe('passthrough');
  });

  it('reports orchestrator modalities from model capabilities', async () => {
    const host = { async modelCapabilities() { return ['tools', 'vision', 'pdf']; } } as unknown as AgentHost;
    const a = new GatewayAdmin({ config: new ConfigStore(createPaths(dir)), keychain, host, paths: createGatewayPaths(dir) });
    expect(await a.modelModalities()).toEqual({ image: true, pdf: true, audio: false });
  });
});
