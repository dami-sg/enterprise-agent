/**
 * Schedules (§7 定时编排): SCHEDULE.md parsing (ScheduleRegistry), durable run
 * state (ScheduleStore), and the host's discovery + manual-run error paths. The
 * happy-path fire needs a configured model/provider, so it's exercised by the
 * higher-level integration suites; here we lock the parse/state/wiring contracts.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleRegistry } from '../src/schedules/registry.js';
import { ScheduleStore } from '../src/storage/schedule-store.js';
import { parseScheduleGrants } from '../src/schedules/grants.js';
import { createAgentHost } from '../src/index.js';

function writeSchedule(root: string, name: string, md: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SCHEDULE.md'), md, 'utf8');
}

describe('ScheduleRegistry — SCHEDULE.md parsing', () => {
  it('parses cron, mode, session, deliver-to, grants, enabled, and the goal body', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-sched-'));
    writeSchedule(
      root,
      'daily-digest',
      [
        '---',
        'name: daily-digest',
        'description: daily ops report',
        'cron: "0 9 * * *"',
        'timezone: Asia/Shanghai',
        'mode: auto',
        'agent: analyst',
        'session: fresh',
        'deliver-to: weixin:ops',
        'grants: exec, write',
        'enabled: true',
        '---',
        'Summarize yesterday\'s merged PRs and CI failures.',
      ].join('\n'),
    );
    const def = new ScheduleRegistry([root]).get('daily-digest')!;
    expect(def.cron).toBe('0 9 * * *');
    expect(def.timezone).toBe('Asia/Shanghai');
    expect(def.mode).toBe('auto');
    expect(def.agent).toBe('analyst');
    expect(def.session).toEqual({ kind: 'fresh' });
    expect(def.deliverTo).toBe('weixin:ops');
    expect(def.grants).toEqual(['exec', 'write']);
    expect(def.enabled).toBe(true);
    expect(def.goal).toBe("Summarize yesterday's merged PRs and CI failures.");
  });

  it('defaults mode to auto (unattended), session to fresh; enabled:false honored', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-sched-'));
    writeSchedule(root, 'minimal', '---\nname: minimal\ndescription: d\n---\ndo a thing');
    writeSchedule(root, 'off', '---\nname: off\ndescription: d\nenabled: false\nmode: bogus\n---\nx');
    const reg = new ScheduleRegistry([root]);
    const minimal = reg.get('minimal')!;
    expect(minimal.mode).toBe('auto');
    expect(minimal.session).toEqual({ kind: 'fresh' });
    expect(minimal.enabled).toBe(true);
    expect(minimal.onMissed).toBe('run-once'); // default catch-up policy
    // Unknown mode string falls back to auto (never a hanging `ask`).
    expect(reg.get('off')!.mode).toBe('auto');
    expect(reg.get('off')!.enabled).toBe(false);
  });

  it('parses session: reuse:<id>; fail-closed on missing name', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-sched-'));
    writeSchedule(root, 'reuser', '---\nname: reuser\ndescription: d\nsession: reuse:sess-123\non-missed: skip\n---\ngo');
    writeSchedule(root, 'broken', '---\ndescription: no name\n---\ngo');
    const reg = new ScheduleRegistry([root]);
    expect(reg.get('reuser')!.session).toEqual({ kind: 'reuse', id: 'sess-123' });
    expect(reg.get('reuser')!.onMissed).toBe('skip');
    expect(reg.get('broken')).toBeUndefined();
  });
});

describe('ScheduleStore — durable run state', () => {
  it('persists state and replays latest-wins across a reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'ea-sched-'));
    const file = join(root, 'schedules-state.jsonl');
    const store = new ScheduleStore(file);
    store.put({ name: 'a', lastRunAt: 1, lastStatus: 'done', nextRunAt: 100 });
    store.put({ name: 'a', lastRunAt: 2, lastStatus: 'error' }); // merge over prior
    store.put({ name: 'b', nextRunAt: 50 });

    // Reopen: the log replays, later lines win, fields merge.
    const reopened = new ScheduleStore(file);
    expect(reopened.get('a')).toMatchObject({ lastRunAt: 2, lastStatus: 'error', nextRunAt: 100 });
    expect(reopened.get('b')).toMatchObject({ nextRunAt: 50 });
    expect(reopened.all().map((s) => s.name).sort()).toEqual(['a', 'b']);
  });
});

describe('parseScheduleGrants — fine-grained pre-authorization (§7 B.3)', () => {
  it('maps <cap>:<scope> to session grant-table entries; drops bare/unknown', () => {
    const grants = parseScheduleGrants(['exec:git', 'write:/repo', 'http:api.github.com', 'exec', 'bogus:x'], 'orch');
    expect(grants).toEqual([
      { tool: 'runCommand', grantKey: 'git', agentId: 'orch', agentScoped: false },
      { tool: 'writeFile', grantKey: '/repo', agentId: 'orch', agentScoped: false },
      { tool: 'applyPatch', grantKey: '/repo', agentId: 'orch', agentScoped: false },
      { tool: 'httpFetch', grantKey: 'api.github.com', agentId: 'orch', agentScoped: false },
    ]);
  });
});

describe('AgentHost — schedule discovery & manual-run errors (§7)', () => {
  it('listSchedules discovers definitions with no state yet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ea-home-'));
    writeSchedule(join(home, 'schedules'), 'weekly', '---\nname: weekly\ndescription: weekly digest\ncron: "0 9 * * 1"\n---\nweekly report');
    const host = createAgentHost({ root: home });
    const list = await host.listSchedules();
    const weekly = list.find((s) => s.name === 'weekly')!;
    expect(weekly.cron).toBe('0 9 * * 1');
    expect(weekly.state).toBeUndefined();
    await host.dispose();
  });

  it('runScheduleNow rejects an unknown schedule and a missing reuse session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ea-home-'));
    writeSchedule(join(home, 'schedules'), 'reuser', '---\nname: reuser\ndescription: d\nsession: reuse:ghost\n---\ngo');
    const host = createAgentHost({ root: home });
    await expect(host.runScheduleNow('nope')).rejects.toThrow(/not found/);
    await expect(host.runScheduleNow('reuser')).rejects.toThrow(/reuse session ghost not found/);
    await host.dispose();
  });
});
