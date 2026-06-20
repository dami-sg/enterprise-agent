import { describe, it, expect } from 'vitest';
import { keyRefFor, isLocalBase } from '../src/core/provider.js';

describe('provider helpers (cli §10 / agent §2.6)', () => {
  it('derives a stable keychain ref from the provider id', () => {
    // The store/fetch path on both the CLI and the TUI depends on this exact
    // scheme — a drift would orphan every persisted key. Pin it.
    expect(keyRefFor('openai')).toBe('openai.key');
    expect(keyRefFor('my-gateway')).toBe('my-gateway.key');
  });

  it('treats localhost endpoints as key-free, everything else as needing a key', () => {
    expect(isLocalBase('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBase('http://127.0.0.1:1234')).toBe(true);
    expect(isLocalBase('http://[::1]:8080')).toBe(true);
    expect(isLocalBase('https://api.openai.com/v1')).toBe(false);
    expect(isLocalBase('not a url')).toBe(false);
    expect(isLocalBase(undefined)).toBe(false);
  });
});
