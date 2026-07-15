import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHost } from '../src/index.js';
import { ConfigStore } from '../src/config/store.js';
import { createPaths } from '../src/config/paths.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'zt-home-'));
}

describe('ConfigStore two-level merge (agent §2.5/§5.2)', () => {
  it('session overrides global, missing falls back to default', () => {
    const home = tmpHome();
    const paths = createPaths(home);
    const cfg = new ConfigStore(paths);
    cfg.saveSettings({
      compactRatio: 0.8,
      sandbox: { enabled: true },
      model: { orchestratorAlias: 'global-orch' },
    });
    const eff = cfg.effective(
      { sandbox: { enabled: false }, model: { orchestratorAlias: 'session-orch' } },
      [],
    );
    expect(eff.sandboxEnabled).toBe(false); // session override
    expect(eff.sandboxNetwork).toBe(true); // default: network open (agent §4.1)
    expect(eff.orchestratorAlias).toBe('session-orch'); // session override
    expect(eff.compactRatio).toBe(0.8); // from global
    expect(eff.maxDepth).toBe(3); // built-in default
  });
});

describe('modelCapabilities — media gating (multimodal §3.1)', () => {
  it('honors image declared on the orchestrator alias for a catalog-unknown model', async () => {
    const home = tmpHome();
    const cfg = new ConfigStore(createPaths(home));
    // A custom multimodal model the metadata catalog doesn't cover: the user
    // declares its modalities on the alias (the escape hatch assertCapability
    // already trusts). The media gate must see `image`, not degrade to a file.
    cfg.saveSettings({ model: { orchestratorAlias: 'orchestrator' } });
    cfg.saveGlobalAliases([
      { alias: 'orchestrator', ref: 'stepfun:step-vision-flash', capabilities: ['tool_call', 'image', 'pdf'] },
    ]);
    const host = createAgentHost({ root: home });
    expect(await host.modelCapabilities()).toEqual(expect.arrayContaining(['image', 'pdf']));
    await host.dispose();
  });

  it('falls back to the metadata catalog when the alias declares no capabilities', async () => {
    const home = tmpHome();
    const cfg = new ConfigStore(createPaths(home));
    cfg.saveGlobalAliases([{ alias: 'orchestrator', ref: 'anthropic:claude-sonnet-4.5' }]);
    const host = createAgentHost({ root: home });
    expect(await host.modelCapabilities()).toEqual(expect.arrayContaining(['image', 'pdf']));
    await host.dispose();
  });
});

describe('AgentHost session management (agent §6.1)', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });

  it('creates and lists sessions (with and without a working directory)', async () => {
    const host = createAgentHost({ root: home });

    // A session bound to a working directory (former Work).
    const proj = await host.createSession({ name: 'Proj', workingDir: home });
    expect(proj.workingDir).toBe(home);
    expect(proj.isActive).toBe(true); // first session is active

    // A session with no working directory (former Chat) → default working dir.
    const quick = await host.createSession({ name: 'Quick' });
    expect(quick.workingDir).toBeUndefined();

    expect((await host.listSessions()).map((s) => s.id)).toEqual(
      expect.arrayContaining([proj.id, quick.id]),
    );

    const updated = await host.updateSessionConfig(proj.id, { maxSteps: 99 });
    expect(updated.config.maxSteps).toBe(99);

    // Rename (auto-titling after the first round) persists across reads.
    const renamed = await host.renameSession(proj.id, '重构鉴权');
    expect(renamed.name).toBe('重构鉴权');
    expect((await host.listSessions()).find((s) => s.id === proj.id)?.name).toBe('重构鉴权');

    await host.switchSession(quick.id);
    expect((await host.listSessions()).find((s) => s.id === quick.id)?.isActive).toBe(true);

    await host.deleteSession(quick.id);
    expect((await host.listSessions()).map((s) => s.id)).not.toContain(quick.id);

    await host.dispose();
  });
});

describe('setModelMeta — manual override for models with no preset (agent §2.6)', () => {
  it('persists a normalized override and registers it live', async () => {
    const home = tmpHome();
    const host = createAgentHost({ root: home });
    await host.setModelMeta({
      ref: 'custom:m1',
      contextWindow: 123456.7,
      maxOutputTokens: 4096,
      price: { input: 1.5, output: 6 },
      // an unknown capability must be dropped, not smuggled through
      capabilities: ['text', 'tool_call', 'bogus' as never],
    });

    const saved = new ConfigStore(createPaths(home)).loadModelMeta();
    expect(saved).toEqual([
      {
        ref: 'custom:m1',
        contextWindow: 123457, // rounded
        maxOutputTokens: 4096,
        price: { input: 1.5, output: 6 },
        capabilities: ['text', 'tool_call'], // 'bogus' dropped
      },
    ]);
    // Registered live → capabilities resolve immediately for that ref.
    expect(await host.modelCapabilities('custom:m1')).toEqual(['text', 'tool_call']);
    await host.dispose();
  });

  it('a reconstructed host loads the persisted override', async () => {
    const home = tmpHome();
    const h1 = createAgentHost({ root: home });
    await h1.setModelMeta({ ref: 'custom:m2', contextWindow: 64000, maxOutputTokens: 8000, capabilities: ['image'] });
    await h1.dispose();

    const h2 = createAgentHost({ root: home });
    expect(await h2.modelCapabilities('custom:m2')).toEqual(['image']);
    await h2.dispose();
  });

  it('re-saving the same ref replaces (not duplicates) the entry', async () => {
    const home = tmpHome();
    const host = createAgentHost({ root: home });
    await host.setModelMeta({ ref: 'custom:m3', contextWindow: 32000, maxOutputTokens: 4000 });
    await host.setModelMeta({ ref: 'custom:m3', contextWindow: 48000, maxOutputTokens: 4000 });
    const saved = new ConfigStore(createPaths(home)).loadModelMeta();
    expect(saved).toEqual([{ ref: 'custom:m3', contextWindow: 48000, maxOutputTokens: 4000 }]);
    await host.dispose();
  });

  it('rejects a bad ref or a non-positive window', async () => {
    const home = tmpHome();
    const host = createAgentHost({ root: home });
    await expect(
      host.setModelMeta({ ref: 'noColon', contextWindow: 1000, maxOutputTokens: 100 }),
    ).rejects.toThrow(/provider:model/);
    await expect(
      host.setModelMeta({ ref: 'p:m', contextWindow: 0, maxOutputTokens: 100 }),
    ).rejects.toThrow(/contextWindow/);
    // nothing persisted after failed validation
    expect(new ConfigStore(createPaths(home)).loadModelMeta()).toEqual([]);
    await host.dispose();
  });
});
