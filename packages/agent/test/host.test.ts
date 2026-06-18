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
  it('workspace overrides global, missing falls back to default', () => {
    const home = tmpHome();
    const paths = createPaths(home);
    const cfg = new ConfigStore(paths);
    cfg.saveSettings({
      compactRatio: 0.8,
      sandbox: { enabled: true },
      model: { orchestratorAlias: 'global-orch' },
    });
    const eff = cfg.effective(
      { sandbox: { enabled: false }, model: { orchestratorAlias: 'ws-orch' } },
      [],
    );
    expect(eff.sandboxEnabled).toBe(false); // workspace override
    expect(eff.orchestratorAlias).toBe('ws-orch'); // workspace override
    expect(eff.compactRatio).toBe(0.8); // from global
    expect(eff.maxDepth).toBe(3); // built-in default
  });
});

describe('AgentHost container management (agent §6.1)', () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });

  it('creates and lists workspaces, works, and chats', async () => {
    const host = createAgentHost({ root: home });
    const ws = await host.createWorkspace({ name: 'Proj', rootPath: home });
    expect((await host.listWorkspaces()).map((w) => w.id)).toContain(ws.id);
    expect(ws.isActive).toBe(true); // first workspace is active

    const chat = await host.createChat({ name: 'Quick' });
    expect((await host.listChats()).map((c) => c.id)).toContain(chat.id);

    const updated = await host.updateWorkspaceConfig(ws.id, { maxSteps: 99 });
    expect(updated.config.maxSteps).toBe(99);
    await host.dispose();
  });
});
