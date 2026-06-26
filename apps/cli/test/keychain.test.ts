import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKeychain } from '../src/host/keychain.js';

// The OS keychain backend was removed (cli §7): keys are now stored in a 0600
// plaintext `secrets.json` under the app root on every platform. These tests
// pin that contract.
describe('createKeychain — plaintext file store (cli §7 / §10)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ea-keychain-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('always reports the insecure file backend (no OS keychain)', () => {
    const info = createKeychain(root);
    expect(info.backend).toBe('file');
    expect(info.insecure).toBe(true);
  });

  it('round-trips set/get/delete and persists plaintext to secrets.json', () => {
    const { store } = createKeychain(root);
    const secret = 'sk-ant-SECRET';

    expect(store.get('openai.key')).toBeUndefined();
    store.set('openai.key', secret);
    expect(store.get('openai.key')).toBe(secret);

    // The plaintext lands on disk verbatim (that is the whole point now).
    const file = join(root, 'secrets.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))['openai.key']).toBe(secret);

    store.delete('openai.key');
    expect(store.get('openai.key')).toBeUndefined();
  });

  it('preserves the exact secret, including shell-significant characters', () => {
    const { store } = createKeychain(root);
    const secret = 'a b"c`d$(e)&|;\\f';
    store.set('p.key', secret);
    expect(store.get('p.key')).toBe(secret);
  });

  it('writes the store with 0600 permissions', () => {
    const { store } = createKeychain(root);
    store.set('p.key', 'v');
    const mode = statSync(join(root, 'secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('surfaces a corrupt store instead of silently dropping every other key', () => {
    const file = join(root, 'secrets.json');
    writeFileSync(file, '{ not json');
    const { store } = createKeychain(root);
    expect(() => store.get('p.key')).toThrow();
    // The corrupt file is left intact for the user to fix, not overwritten.
    expect(existsSync(file)).toBe(true);
  });
});
