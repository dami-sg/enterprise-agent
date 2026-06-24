/**
 * Schedule fire — END-TO-END (§7). Exercises the REAL path that the unit suites
 * can't: runScheduleNow → createSession → openSession → orchestrator ToolLoopAgent
 * runs against a model → final text captured → `schedule-fired` / `schedule-finished`
 * emitted → run state persisted. The model is a local OpenAI-compatible mock HTTP
 * server, so the whole ModelRegistry → provider transport → AI SDK chain is real;
 * only the network endpoint is faked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAgentHost } from '../src/index.js';
import { ConfigStore } from '../src/config/store.js';
import { createPaths } from '../src/config/paths.js';
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';

const REPLY = '已生成日报：昨天合并 3 个 PR，0 个 CI 失败。';

/** Minimal OpenAI-compatible /chat/completions SSE endpoint returning REPLY. */
function startMockModel(): Promise<{ server: Server; baseURL: string }> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    // Drain the request body, then stream a single assistant message + usage.
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (obj: unknown): void => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: 'cmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock-model' };
      chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: REPLY }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseURL: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/** Seed a host home with a mock provider wired as the orchestrator + a schedule. */
function seedHome(baseURL: string, scheduleMd: string): string {
  const home = mkdtempSync(join(tmpdir(), 'ea-sched-e2e-'));
  const cfg = new ConfigStore(createPaths(home));
  cfg.saveProviders([{ id: 'mock', kind: 'openai-compatible', baseURL, enabled: true }]);
  cfg.saveGlobalAliases([{ alias: 'orchestrator', ref: 'mock:mock-model', capabilities: ['tools'] }]);
  cfg.saveSettings({ model: { orchestratorAlias: 'orchestrator' }, sandbox: { enabled: false } });
  const dir = join(home, 'schedules', 'daily-digest');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SCHEDULE.md'), scheduleMd, 'utf8');
  return home;
}

let mock: { server: Server; baseURL: string };
beforeAll(async () => {
  mock = await startMockModel();
});
afterAll(() => {
  mock.server.close();
});

describe('runScheduleNow — full fire (§7 end-to-end)', () => {
  it('fires a fresh-session schedule, captures the result, emits fired+finished, records state', async () => {
    const home = seedHome(
      mock.baseURL,
      '---\nname: daily-digest\ndescription: daily ops report\ncron: 0 9 * * *\nmode: auto\n---\n出一份运维日报。',
    );
    const host = createAgentHost({ root: home });
    const events: AgentStreamEvent[] = [];
    host.onEvent((e) => events.push(e));

    const result = await host.runScheduleNow('daily-digest');

    // The orchestrator actually ran against the (mock) model and produced text.
    expect(result.status).toBe('done');
    expect(result.runId).toBeTruthy();
    expect(result.sessionId).toBeTruthy();

    // A fresh session was created and named after the schedule.
    const sessions = await host.listSessions();
    expect(sessions.find((s) => s.id === result.sessionId)?.name).toBe('schedule:daily-digest');

    // Both lifecycle events fired, finished carries the captured summary.
    const fired = events.find((e) => e.kind === 'schedule-fired');
    const finished = events.find((e) => e.kind === 'schedule-finished');
    expect(fired).toMatchObject({ name: 'daily-digest', sessionId: result.sessionId, runId: result.runId });
    expect(finished).toMatchObject({ name: 'daily-digest', status: 'done' });
    expect((finished as { summary: string }).summary).toContain('3 个 PR');

    // Run state was persisted (durable §7) — visible via listSchedules.
    const listed = (await host.listSchedules()).find((s) => s.name === 'daily-digest');
    expect(listed?.state).toMatchObject({ lastRunId: result.runId, lastStatus: 'done' });
    expect(listed?.state?.lastRunAt).toBeGreaterThan(0);

    await host.dispose();
  });

  it('carries deliver-to onto the finished event so a host can route the summary', async () => {
    const home = seedHome(
      mock.baseURL,
      '---\nname: digest2\ndescription: d\ncron: 0 9 * * *\ndeliver-to: telegram:ops\n---\n汇报。',
    );
    const host = createAgentHost({ root: home });
    const events: AgentStreamEvent[] = [];
    host.onEvent((e) => events.push(e));
    await host.runScheduleNow('digest2');
    const finished = events.find((e) => e.kind === 'schedule-finished') as
      | { deliverTo?: string; summary: string }
      | undefined;
    expect(finished?.deliverTo).toBe('telegram:ops');
    expect(finished?.summary).toContain('PR');
    await host.dispose();
  });
});
