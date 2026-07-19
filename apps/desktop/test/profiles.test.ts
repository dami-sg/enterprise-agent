/**
 * ProfileStore (desktop-app §3.1/§9.5): default local profile, token
 * encryption at rest (never in profiles.json), TLS enforcement for
 * non-loopback remote URLs, and settings round-trip.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileStore, assertRemoteUrl, type ProfileStoreDeps } from '../src/main/profiles.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ea-desktop-profiles-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

// XOR-ish reversible fake "encryption" so tests don't need Electron safeStorage.
const deps = (): ProfileStoreDeps => ({
  dir,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (blob) => blob.toString('utf8').replace(/^enc:/, ''),
});

describe('defaults', () => {
  it('creates a zero-config local profile on first run and persists it', () => {
    const store = new ProfileStore(deps());
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '本机', mode: 'local', hasToken: false });
    expect(store.activeId()).toBe(list[0]!.id);

    // A second instance over the same dir sees the same profile (no dupes).
    const again = new ProfileStore(deps());
    expect(again.list()).toHaveLength(1);
    expect(again.list()[0]!.id).toBe(list[0]!.id);
  });
});

describe('tokens (§9.5)', () => {
  it('stores tokens encrypted, outside profiles.json, and never over list()', () => {
    const store = new ProfileStore(deps());
    const p = store.upsert({ id: '', name: '公司', mode: 'remote', url: 'wss://gw.example.com/rpc' });
    store.setToken(p.id, 'sk-secret-token');

    expect(store.get(p.id)!.hasToken).toBe(true);
    expect(store.token(p.id)).toBe('sk-secret-token');

    const profilesJson = readFileSync(join(dir, 'profiles.json'), 'utf8');
    expect(profilesJson).not.toContain('sk-secret-token');
    const tokensJson = readFileSync(join(dir, 'profile-tokens.json'), 'utf8');
    expect(tokensJson).not.toContain('sk-secret-token'); // encrypted at rest
    // list() (the IPC surface) never carries token material.
    expect(JSON.stringify(store.list())).not.toContain('sk-secret');
  });

  it('clears the token with null and on profile removal', () => {
    const store = new ProfileStore(deps());
    const p = store.upsert({ id: '', name: 'r', mode: 'remote', url: 'wss://h/rpc' });
    store.setToken(p.id, 't1');
    store.setToken(p.id, null);
    expect(store.get(p.id)!.hasToken).toBe(false);
    store.setToken(p.id, 't2');
    store.remove(p.id);
    expect(readFileSync(join(dir, 'profile-tokens.json'), 'utf8')).not.toContain('t2');
  });
});

describe('remote URL validation (§3.2)', () => {
  it('rejects plaintext ws:// to public hosts', () => {
    expect(() => assertRemoteUrl('ws://gw.example.com/rpc')).toThrow(/wss/);
    expect(() => assertRemoteUrl('ws://8.8.8.8:7320/rpc')).toThrow(/wss/);
    expect(() => assertRemoteUrl('ws://172.32.0.1:7320/rpc')).toThrow(/wss/); // just past 172.16/12
    expect(() => assertRemoteUrl('http://gw.example.com/rpc')).toThrow();
    // Loopback plaintext and any wss are fine.
    expect(() => assertRemoteUrl('ws://127.0.0.1:7320/rpc')).not.toThrow();
    expect(() => assertRemoteUrl('ws://localhost:7320/rpc')).not.toThrow();
    expect(() => assertRemoteUrl('wss://gw.example.com/rpc')).not.toThrow();
    // Private/LAN plaintext is allowed (dev gateways can't get certificates).
    expect(() => assertRemoteUrl('ws://192.168.1.20:7320/rpc')).not.toThrow();
    expect(() => assertRemoteUrl('ws://10.0.0.5:7320/rpc')).not.toThrow();
    expect(() => assertRemoteUrl('ws://172.16.0.9:7320/rpc')).not.toThrow();
    expect(() => assertRemoteUrl('ws://virgil-vm.local:7320/rpc')).not.toThrow();
  });

  it('upsert enforces the same rule', () => {
    const store = new ProfileStore(deps());
    expect(() => store.upsert({ id: '', name: 'x', mode: 'remote', url: 'ws://evil.com/rpc' })).toThrow(/wss/);
  });
});

describe('settings & active profile', () => {
  it('round-trips settings and keeps active id valid after removal', () => {
    const store = new ProfileStore(deps());
    expect(store.settings().stopGatewayOnQuit).toBe(false);
    expect(store.settings().language).toBe('system');
    store.updateSettings({ stopGatewayOnQuit: true, language: 'en' });
    expect(new ProfileStore(deps()).settings()).toMatchObject({ stopGatewayOnQuit: true, language: 'en' });

    const p = store.upsert({ id: '', name: 'r', mode: 'remote', url: 'wss://h/rpc' });
    store.setActive(p.id);
    store.remove(p.id);
    expect(store.activeId()).toBe(store.list()[0]!.id);
  });
});

describe('upsert runtime validation (IPC boundary)', () => {
  it('rejects non-integer / out-of-range / non-number ports', () => {
    const store = new ProfileStore(deps());
    const local = (over: Record<string, unknown>) =>
      store.upsert({ id: '', name: 'l', mode: 'local', ...over } as never);
    // A string port would be interpolated into `ws://127.0.0.1:${port}/rpc` —
    // "0@evil.com" turns the loopback prefix into userinfo and dials evil.com.
    expect(() => local({ rpcPort: '0@evil.com' })).toThrow(/1–65535/);
    expect(() => local({ rpcPort: 0 })).toThrow(/1–65535/);
    expect(() => local({ rpcPort: 65536 })).toThrow(/1–65535/);
    expect(() => local({ rpcPort: 12.5 })).toThrow(/1–65535/);
    expect(() => local({ panelPort: '7317; rm -rf /' })).toThrow(/1–65535/);
    expect(() => local({ rpcPort: 7321, panelPort: 7318 })).not.toThrow();
  });

  it('requires a non-empty name and a known mode, and drops extra keys', () => {
    const store = new ProfileStore(deps());
    expect(() => store.upsert({ id: '', name: '  ', mode: 'local' })).toThrow(/名称/);
    expect(() => store.upsert({ id: '', name: 'x', mode: 'weird' } as never)).toThrow(/mode/);
    const saved = store.upsert({ id: '', name: 'x', mode: 'local', evil: true } as never);
    expect('evil' in saved).toBe(false);
  });
});
