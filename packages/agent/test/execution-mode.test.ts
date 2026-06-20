/**
 * Execution modes (agent §3.8) — Phase 0: mode plumbing + the enforceMode gate.
 * Covers config resolution, the live-mutable mode ref + mode-changed event, the
 * plan-mode read-only lockdown (incl. the network toggle), and that ask/auto
 * fall through to the existing approval gate (zero regression).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHarness } from './helpers/harness.js';
import { Session as RuntimeSession } from '../src/runtime/session.js';
import { buildFileTools } from '../src/tools/file.js';
import { buildExecTools } from '../src/tools/exec.js';
import { buildHttpTools } from '../src/tools/http.js';
import { buildPlanTools } from '../src/tools/plan.js';
import { PlanController } from '../src/runtime/plan.js';
import { AutoClassifier } from '../src/runtime/auto-classifier.js';
import { SessionStore } from '../src/storage/session-store.js';
import { ConfigStore } from '../src/config/store.js';
import { createPaths } from '../src/config/paths.js';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModel } from 'ai';

const call = (tool: unknown, input: unknown, toolCallId = 'tc-1') =>
  (tool as { execute: (i: unknown, o: { toolCallId: string }) => Promise<any> }).execute(input, { toolCallId });

describe('effective() execution-mode resolution (agent §3.8)', () => {
  it('defaults to ask + plan network on; session overrides global', () => {
    const cfg = new ConfigStore(createPaths(mkdtempSync(join(tmpdir(), 'ea-em-'))));
    expect(cfg.effective(undefined, [])).toMatchObject({ executionMode: 'ask', planAllowNetwork: true });

    cfg.saveSettings({ executionMode: 'auto', plan: { allowNetwork: false } });
    expect(cfg.effective(undefined, [])).toMatchObject({ executionMode: 'auto', planAllowNetwork: false });
    // Session scope wins over global.
    expect(cfg.effective({ executionMode: 'plan', plan: { allowNetwork: true } }, [])).toMatchObject({
      executionMode: 'plan',
      planAllowNetwork: true,
    });
  });
});

describe('Session.setExecutionMode (agent §3.8.1)', () => {
  const makeSession = (h: ReturnType<typeof makeHarness>) =>
    new RuntimeSession(h.services, h.store, {
      goal: 'g',
      buildSkillCatalog: () => '',
      maxSteps: 1,
      compactRatio: 0.9,
      orchestratorModelRef: 'mock:mock-model',
    });

  it('mutates the shared ref and emits mode-changed, idempotently', () => {
    const h = makeHarness();
    const session = makeSession(h);
    expect(session.getExecutionMode()).toBe('ask');

    session.setExecutionMode('plan');
    expect(h.services.executionMode.value).toBe('plan');
    expect(h.events).toContainEqual({ kind: 'mode-changed', sessionId: h.services.sessionId, mode: 'plan' });

    // Setting the same mode again is a no-op (no duplicate event).
    const before = h.events.filter((e) => e.kind === 'mode-changed').length;
    session.setExecutionMode('plan');
    expect(h.events.filter((e) => e.kind === 'mode-changed').length).toBe(before);
    h.cleanup();
  });
});

describe('enforceMode: plan-mode read-only lockdown (agent §3.8.2/§3.8.4)', () => {
  it('blocks write/exec tools, records a blocked-plan audit, and writes nothing', async () => {
    const h = makeHarness({ executionMode: 'plan', autoApprove: 'once' });
    const file = buildFileTools(h.parent);
    const exec = buildExecTools(h.parent);
    const target = join(h.rootPaths[0]!, 'should-not-exist.txt');

    const w = await call(file.writeFile, { path: target, content: 'x' });
    expect(w).toMatchObject({ error: 'plan_mode' });
    expect(existsSync(target)).toBe(false); // never executed

    expect(await call(file.applyPatch, { path: target, find: 'a', replace: 'b' })).toMatchObject({ error: 'plan_mode' });
    expect(await call(exec.runCommand, { command: 'git', args: ['status'] })).toMatchObject({ error: 'plan_mode' });
    expect(await call(exec.runScript, { interpreter: 'bash', script: 'echo hi' })).toMatchObject({ error: 'plan_mode' });

    const blocked = h.audit.all().filter((r) => r.approval === 'blocked-plan');
    expect(blocked.map((r) => r.tool).sort()).toEqual(['applyPatch', 'runCommand', 'runScript', 'writeFile']);
    // No approval was ever requested — plan blocks before the gate.
    expect(h.gateRequests).toHaveLength(0);
    h.cleanup();
  });

  it('allows read-only tools in plan mode', async () => {
    const h = makeHarness({ executionMode: 'plan' });
    const file = buildFileTools(h.parent);
    const ls = await call(file.listDir, { path: h.rootPaths[0]! });
    expect((ls as { error?: string }).error).toBeUndefined();
    h.cleanup();
  });

  it('gates network by plan.allowNetwork: passes the plan gate when on, blocks when off', async () => {
    // allowNetwork on → httpFetch clears the plan gate and reaches the approval
    // gate (rejected here), proving it was NOT blocked by plan.
    const on = makeHarness({ executionMode: 'plan', planAllowNetwork: true, autoApprove: 'reject' });
    expect(await call(buildHttpTools(on.parent).httpFetch, { url: 'https://example.com' })).toMatchObject({
      error: 'rejected',
    });
    on.cleanup();

    const off = makeHarness({ executionMode: 'plan', planAllowNetwork: false, autoApprove: 'reject' });
    expect(await call(buildHttpTools(off.parent).httpFetch, { url: 'https://example.com' })).toMatchObject({
      error: 'plan_mode',
    });
    off.cleanup();
  });
});

describe('enforceMode: ask/auto fall through to the approval gate (zero regression)', () => {
  it('ask mode writes the file once approved (unchanged behavior)', async () => {
    const h = makeHarness({ executionMode: 'ask', autoApprove: 'once' });
    const target = join(h.rootPaths[0]!, 'written.txt');
    const w = await call(buildFileTools(h.parent).writeFile, { path: target, content: 'hello' });
    expect(w).toMatchObject({ ok: true });
    expect(existsSync(target)).toBe(true);
    expect(h.gateRequests.map((r) => r.toolName)).toContain('writeFile'); // went through approval
    h.cleanup();
  });

  it('auto mode (Phase 0, no classifier yet) behaves as ask', async () => {
    const h = makeHarness({ executionMode: 'auto', autoApprove: 'once' });
    const target = join(h.rootPaths[0]!, 'auto.txt');
    const w = await call(buildFileTools(h.parent).writeFile, { path: target, content: 'hi' });
    expect(w).toMatchObject({ ok: true });
    expect(existsSync(target)).toBe(true);
    expect(h.gateRequests.map((r) => r.toolName)).toContain('writeFile'); // still asks (no auto-allow)
    h.cleanup();
  });

  it('a live mode switch is seen by the same tool instance (no re-assembly)', async () => {
    const h = makeHarness({ executionMode: 'plan', autoApprove: 'once' });
    const writeFile = buildFileTools(h.parent).writeFile;
    const target = join(h.rootPaths[0]!, 'live.txt');

    expect(await call(writeFile, { path: target, content: 'x' }, 'a')).toMatchObject({ error: 'plan_mode' });
    // Flip plan → ask on the shared ref; the SAME tool instance now executes.
    h.services.executionMode.value = 'ask';
    expect(await call(writeFile, { path: target, content: 'x' }, 'b')).toMatchObject({ ok: true });
    expect(existsSync(target)).toBe(true);
    h.cleanup();
  });
});

describe('PlanController suspend/resume bridge (agent §3.8.4)', () => {
  it('approve echoes the plan (or the edited plan); keep/reject/cancel settle', async () => {
    const seen: { planId: string }[] = [];
    const pc = new PlanController({ emitPlanProposed: (r) => seen.push({ planId: r.planId }) });

    const a = pc.propose({ runId: 'r', agentId: 'orch', planId: 'p1', plan: 'PLAN-A' });
    expect(seen).toEqual([{ planId: 'p1' }]);
    expect(pc.resolve('p1', 'approve', { targetMode: 'auto' })).toBe(true);
    expect(await a).toEqual({ decision: 'approve', plan: 'PLAN-A', targetMode: 'auto' });

    // edit → approve with the edited text.
    const b = pc.propose({ runId: 'r', agentId: 'orch', planId: 'p2', plan: 'PLAN-B' });
    pc.resolve('p2', 'edit', { editedPlan: 'PLAN-B*' });
    expect(await b).toEqual({ decision: 'approve', plan: 'PLAN-B*', targetMode: undefined });

    const k = pc.propose({ runId: 'r', agentId: 'orch', planId: 'p3', plan: 'x' });
    pc.resolve('p3', 'keep');
    expect(await k).toEqual({ decision: 'keep' });

    // Unknown id is a no-op; cancelAll rejects anything in flight.
    expect(pc.resolve('nope', 'approve')).toBe(false);
    const c = pc.propose({ runId: 'r', agentId: 'orch', planId: 'p4', plan: 'x' });
    pc.cancelAll();
    expect(await c).toEqual({ decision: 'reject' });
  });
});

describe('exitPlanMode tool (agent §3.8.4)', () => {
  it('is a no-op outside plan mode', async () => {
    const h = makeHarness({ executionMode: 'ask' });
    const { exitPlanMode } = buildPlanTools(h.parent);
    expect(await call(exitPlanMode, { plan: 'x' }, 'pm0')).toMatchObject({ error: 'not_in_plan_mode' });
    h.cleanup();
  });

  it('approval switches mode, pre-grants declared actions, and returns the plan', async () => {
    const h = makeHarness({ executionMode: 'plan' });
    const { exitPlanMode } = buildPlanTools(h.parent);

    const pending = call(
      exitPlanMode,
      { plan: 'Ship it', allowedActions: [{ tool: 'runCommand', grantKey: 'git', reason: 'commit' }] },
      'pm1',
    );
    // plan-proposed is emitted synchronously before the suspend.
    await Promise.resolve();
    expect(h.events).toContainEqual(
      expect.objectContaining({ kind: 'plan-proposed', planId: 'pm1', plan: 'Ship it' }),
    );

    expect(h.services.plan.resolve('pm1', 'approve', { targetMode: 'ask' })).toBe(true);
    const r = await pending;

    expect(r).toMatchObject({ approved: true, mode: 'ask', plan: 'Ship it' });
    expect(h.services.executionMode.value).toBe('ask'); // left plan mode
    expect(h.events).toContainEqual({ kind: 'mode-changed', sessionId: h.services.sessionId, mode: 'ask' });
    // The declared action is now a session grant (auto-allows without a prompt).
    expect(h.grants.match('runCommand', 'git', 'orch')).toBeTruthy();
    const audited = h.audit.all().filter((x) => x.approval === 'plan-approved');
    expect(audited).toEqual([expect.objectContaining({ tool: 'runCommand', grantKey: 'git' })]);
    h.cleanup();
  });

  it('keep stays in plan mode; reject stays in plan mode', async () => {
    for (const decision of ['keep', 'reject'] as const) {
      const h = makeHarness({ executionMode: 'plan' });
      const { exitPlanMode } = buildPlanTools(h.parent);
      const pending = call(exitPlanMode, { plan: 'p' }, 'pm');
      await Promise.resolve();
      h.services.plan.resolve('pm', decision);
      expect(await pending).toMatchObject({ approved: false, decision });
      expect(h.services.executionMode.value).toBe('plan'); // unchanged
      h.cleanup();
    }
  });
});

describe('AutoClassifier (agent §3.8.5)', () => {
  const genModel = (impl: () => Promise<{ text: string }> | never): LanguageModel =>
    new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock',
      doGenerate: async () => {
        const { text } = await impl();
        return {
          content: [{ type: 'text', text }],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
      },
    });
  const store = () => new SessionStore(join(mkdtempSync(join(tmpdir(), 'ea-cls-')), 'session.jsonl'));
  const reply = (text: string) => genModel(async () => ({ text }));

  it('parses allow / deny / ask verdicts', async () => {
    const cases = [
      ['reasoning…\nVERDICT: allow\nREASON: read-only', 'allow', 'read-only'],
      ['VERDICT: deny\nREASON: rm -rf is destructive', 'deny', 'rm -rf is destructive'],
      ['VERDICT: ask\nREASON: ambiguous', 'ask', 'ambiguous'],
    ] as const;
    for (const [text, verdict, reason] of cases) {
      const c = new AutoClassifier(() => reply(text), store());
      expect(await c.classify({ toolName: 'runCommand', grantKey: 'rm', input: {} })).toEqual({ verdict, reason });
    }
  });

  it('fail-closed: a model error degrades to ask (unavailable)', async () => {
    const c = new AutoClassifier(
      () =>
        genModel(() => {
          throw new Error('network down');
        }),
      store(),
    );
    const r = await c.classify({ toolName: 'writeFile', grantKey: '/repo', input: {} });
    expect(r).toMatchObject({ verdict: 'ask', unavailable: true });
  });

  it('fail-closed: unparseable output degrades to ask', async () => {
    const c = new AutoClassifier(() => reply('I think this is fine, go ahead.'), store());
    expect((await c.classify({ toolName: 'runCommand', grantKey: 'git', input: {} })).verdict).toBe('ask');
  });
});

describe('auto-mode gate (agent §3.8.5)', () => {
  it('allow → runs silently (no prompt) + audits auto-allow', async () => {
    const h = makeHarness({ executionMode: 'auto', auto: { classify: async () => ({ verdict: 'allow', reason: 'safe' }) } });
    const target = join(h.rootPaths[0]!, 'a.txt');
    expect(await call(buildFileTools(h.parent).writeFile, { path: target, content: 'x' })).toMatchObject({ ok: true });
    expect(existsSync(target)).toBe(true);
    expect(h.gateRequests).toHaveLength(0); // never prompted the user
    expect(h.audit.all().filter((r) => r.approval === 'auto-allow')).toEqual([
      expect.objectContaining({ tool: 'writeFile', reason: 'safe' }),
    ]);
    h.cleanup();
  });

  it('deny → blocks, writes nothing, returns auto_denied + audits auto-deny', async () => {
    const h = makeHarness({ executionMode: 'auto', auto: { classify: async () => ({ verdict: 'deny', reason: 'destructive' }) } });
    const target = join(h.rootPaths[0]!, 'b.txt');
    expect(await call(buildFileTools(h.parent).writeFile, { path: target, content: 'x' })).toMatchObject({
      error: 'auto_denied',
      reason: 'destructive',
    });
    expect(existsSync(target)).toBe(false);
    expect(h.audit.all().some((r) => r.approval === 'auto-deny')).toBe(true);
    h.cleanup();
  });

  it('ask → degrades to the human approval gate', async () => {
    const h = makeHarness({
      executionMode: 'auto',
      autoApprove: 'once',
      auto: { classify: async () => ({ verdict: 'ask', reason: 'unsure' }) },
    });
    const target = join(h.rootPaths[0]!, 'c.txt');
    expect(await call(buildFileTools(h.parent).writeFile, { path: target, content: 'x' })).toMatchObject({ ok: true });
    expect(h.gateRequests.map((r) => r.toolName)).toContain('writeFile'); // prompted
    h.cleanup();
  });

  it('circuit breaker (enabled:false) → never classifies, uses the human gate', async () => {
    let classified = 0;
    const h = makeHarness({
      executionMode: 'auto',
      autoApprove: 'once',
      auto: { enabled: false, classify: async () => ((classified += 1), { verdict: 'allow', reason: 'x' }) },
    });
    await call(buildFileTools(h.parent).writeFile, { path: join(h.rootPaths[0]!, 'd.txt'), content: 'x' });
    expect(classified).toBe(0);
    expect(h.gateRequests.map((r) => r.toolName)).toContain('writeFile');
    h.cleanup();
  });

  it('a dangerous interpreter grant is NOT honored in auto — it is re-classified', async () => {
    let classified = 0;
    const h = makeHarness({
      executionMode: 'auto',
      auto: { classify: async () => ((classified += 1), { verdict: 'deny', reason: 'interpreter bypass' }) },
    });
    // Pre-grant runScript bash for this session — in ask mode it would auto-allow.
    h.grants.add({ tool: 'runScript', grantKey: 'bash', agentId: 'orch', agentScoped: false });
    const r = await call(buildExecTools(h.parent).runScript, { interpreter: 'bash', script: 'echo hi' }, 'rs1');
    expect(r).toMatchObject({ error: 'auto_denied' }); // grant ignored, classifier ran
    expect(classified).toBe(1);
    h.cleanup();
  });
});
