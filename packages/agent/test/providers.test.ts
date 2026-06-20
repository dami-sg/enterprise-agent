import { describe, it, expect } from 'vitest';
import { BUILTIN_PROVIDERS, findProviderPreset } from '../src/models/providers.js';

describe('BUILTIN_PROVIDERS preset directory (agent §2.6)', () => {
  it('covers the documented official, third-party and local sources', () => {
    const ids = new Set(BUILTIN_PROVIDERS.map((p) => p.id));
    for (const id of ['openai', 'anthropic', 'google', 'deepseek', 'moonshot', 'openrouter', 'ollama']) {
      expect(ids.has(id)).toBe(true);
    }
    expect(BUILTIN_PROVIDERS.length).toBeGreaterThanOrEqual(10);
  });

  it('gives every openai-compatible preset a versioned baseURL (so `${baseURL}/models` resolves)', () => {
    for (const p of BUILTIN_PROVIDERS.filter((x) => x.kind === 'openai-compatible')) {
      expect(p.baseURL, p.id).toBeTruthy();
      expect(p.baseURL!, p.id).toMatch(/\/(v1|v2|v4|compatible-mode\/v1|api\/paas\/v4)$/);
    }
  });

  it('marks official kinds without a baseURL and local servers as key-free', () => {
    for (const id of ['openai', 'anthropic', 'google']) {
      expect(findProviderPreset(id)!.baseURL).toBeUndefined();
    }
    for (const id of ['ollama', 'lmstudio', 'vllm']) {
      const p = findProviderPreset(id)!;
      expect(p.requiresKey).toBe(false);
      expect(p.region).toBe('local');
      expect(p.baseURL).toMatch(/^http:\/\/localhost:/);
    }
  });

  it('looks up presets case-insensitively and returns undefined for unknowns', () => {
    expect(findProviderPreset('DeepSeek')?.kind).toBe('openai-compatible');
    expect(findProviderPreset('nope')).toBeUndefined();
  });
});
