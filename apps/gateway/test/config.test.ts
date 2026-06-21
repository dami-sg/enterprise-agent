/**
 * Gateway config (gateway §7): load / save and keychain-only secret resolution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyStore } from '@enterprise-agent/agent';
import {
  loadGatewayConfig,
  saveGatewayConfig,
  resolveToken,
  enabledChannels,
} from '../src/config/gateway-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-config-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

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

describe('loadGatewayConfig', () => {
  it('returns an empty config when the file is absent', () => {
    expect(loadGatewayConfig(join(dir, 'nope.json'))).toEqual({ channels: [] });
  });

  it('round-trips through save/load', () => {
    const file = join(dir, 'gateway.json');
    saveGatewayConfig(file, {
      channels: [{ name: 'telegram', enabled: true, token: { keyRef: 'telegram-bot-token' } }],
      verbose: true,
    });
    const loaded = loadGatewayConfig(file);
    expect(loaded.verbose).toBe(true);
    expect(loaded.channels[0]!.name).toBe('telegram');
  });

  it('throws on invalid JSON', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{not json');
    expect(() => loadGatewayConfig(file)).toThrow();
  });
});

describe('resolveToken (gateway §7)', () => {
  it('resolves a keyRef from the keychain', () => {
    const kc = new MemKeyStore();
    kc.set('telegram-bot-token', 'secret123');
    const token = resolveToken({ name: 'telegram', token: { keyRef: 'telegram-bot-token' } }, kc);
    expect(token).toBe('secret123');
  });

  it('throws a clear error when the keyRef is missing', () => {
    const kc = new MemKeyStore();
    expect(() => resolveToken({ name: 'telegram', token: { keyRef: 'absent' } }, kc)).toThrow(/keychain/);
  });

  it('returns undefined when no token is configured', () => {
    expect(resolveToken({ name: 'whatsapp' }, new MemKeyStore())).toBeUndefined();
  });
});

describe('enabledChannels', () => {
  it('treats a missing enabled flag as enabled, excludes false', () => {
    const channels = enabledChannels({
      channels: [{ name: 'a' }, { name: 'b', enabled: false }, { name: 'c', enabled: true }],
    });
    expect(channels.map((c) => c.name)).toEqual(['a', 'c']);
  });
});
