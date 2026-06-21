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

  it('toggles verbose in gateway.json', () => {
    admin.setVerbose(true);
    expect(state().verbose).toBe(true);
  });
});
