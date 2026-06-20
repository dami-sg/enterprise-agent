/**
 * Sub-agent END-TO-END tests (agent §2.3). Unlike sub-agent.test.ts (which only
 * unit-tests the helper functions), these drive a REAL ToolLoopAgent through
 * spawnSubAgentTool with a scripted mock model, proving a sub-agent actually
 * runs under every condition: it executes steps, reads & writes files, calls
 * tools, reaches the network (httpFetch), calls MCP tools, receives a filtered
 * skill catalog, inherits delegated grants, and surfaces approval to the host.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSubAgentTool } from '../src/runtime/sub-agent.js';
import { SkillRegistry } from '../src/skills/loader.js';
import { Session as RuntimeSession } from '../src/runtime/session.js';
import { makeHarness, scriptedModel, callDelegate, type Harness } from './helpers/harness.js';

const harnesses: Harness[] = [];
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.cleanup();
});

describe('a sub-agent actually runs (the core "跑得起来" proof)', () => {
  it('executes a step and returns its final text as the tool result', async () => {
    const h = harness({ defaultModel: scriptedModel([{ text: 'pong' }]) });
    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'analyst',
      objective: 'reply with pong',
    });
    expect(res.output).toBe('pong');
    expect(res.steps).toBeGreaterThanOrEqual(1);
    expect(res.note).toBeUndefined();

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('sub-agent-start');
    expect(kinds).toContain('sub-agent-finish');
  });

  it('runs a multi-step tool loop (call a tool, then answer)', async () => {
    // analyst can read; have it call getCurrentTime then summarize.
    const model = scriptedModel([
      { tool: 'getCurrentTime', input: {} },
      { text: 'the time was fetched' },
    ]);
    const h = harness({ defaultModel: model });
    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'analyst',
      objective: 'what time is it',
    });
    expect(res.output).toBe('the time was fetched');
    expect(res.steps).toBeGreaterThanOrEqual(2);
    // The tool-call + tool-result reached the trace under the sub-agent id.
    const toolCalls = h.events.filter((e) => e.kind === 'tool-call');
    expect(toolCalls.some((e: any) => e.toolName === 'getCurrentTime')).toBe(true);
  });
});

describe('a sub-agent reads and writes files', () => {
  it('coder reads an input file and writes an output file (approval auto-granted)', async () => {
    const h = harness({ autoApprove: 'session' });
    const root = h.rootPaths[0]!;
    writeFileSync(join(root, 'input.txt'), 'hello from input', 'utf8');

    const model = scriptedModel([
      { tool: 'readFile', input: { path: join(root, 'input.txt') } },
      { tool: 'writeFile', input: { path: join(root, 'output.txt'), content: 'written by sub-agent' } },
      { text: 'done: read input.txt and wrote output.txt' },
    ]);
    h.services.modelFor = () => model;

    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'coder',
      objective: 'copy input.txt to output.txt',
    });
    expect(res.output).toMatch(/done/);
    expect(readFileSync(join(root, 'output.txt'), 'utf8')).toBe('written by sub-agent');

    // The write went through the approval gate and was audited.
    const writes = h.audit.all().filter((r) => r.tool === 'writeFile');
    expect(writes.length).toBe(1);
    expect(writes[0]!.agentId).toMatch(/^sub-coder-/);
  });
});

describe('a sub-agent reaches the network (httpFetch)', () => {
  it('researcher makes an HTTP request through the approval gate', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const model = scriptedModel([
        { tool: 'httpFetch', input: { url: 'https://api.example.com/data' } },
        { text: 'fetched the data' },
      ]);
      const h = harness({ defaultModel: model, autoApprove: 'once' });
      const res = await callDelegate(spawnSubAgentTool(h.parent), {
        role: 'researcher',
        objective: 'fetch https://api.example.com/data',
      });
      expect(res.output).toBe('fetched the data');
      expect(calls).toEqual(['https://api.example.com/data']);
      // The fetch was gated by host and audited under the sub-agent.
      const fetches = h.audit.all().filter((r) => r.tool === 'httpFetch');
      expect(fetches.length).toBe(1);
      expect(fetches[0]!.grantKey).toBe('api.example.com');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('a sub-agent calls a connected MCP tool (agent §3.5)', () => {
  it('coder invokes an injected MCP tool and gets its result', async () => {
    const mcpCalls: unknown[] = [];
    const echo = tool({
      description: 'echo back the message',
      inputSchema: z.object({ msg: z.string() }),
      execute: async ({ msg }) => {
        mcpCalls.push(msg);
        return { echoed: msg };
      },
    });
    const model = scriptedModel([
      { tool: 'mcp__test__echo', input: { msg: 'hello mcp' } },
      { text: 'mcp said hello mcp' },
    ]);
    const h = harness({
      defaultModel: model,
      wrapMcpTools: () => ({ mcp__test__echo: echo }),
    });
    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'coder',
      objective: 'echo hello mcp',
    });
    expect(mcpCalls).toEqual(['hello mcp']);
    expect(res.output).toContain('hello mcp');
    const results = h.events.filter((e) => e.kind === 'tool-result');
    expect(results.some((e: any) => JSON.stringify(e.output).includes('hello mcp'))).toBe(true);
  });

  it('the role MCP gate predicate is passed to wrapMcpTools', async () => {
    let seenAllow: ((fq: string) => boolean) | undefined | 'unset' = 'unset';
    const h = harness({
      defaultModel: scriptedModel([{ text: 'done' }]),
      wrapMcpTools: (_ctx, allow) => {
        seenAllow = allow;
        return {};
      },
    });
    await callDelegate(spawnSubAgentTool(h.parent), { role: 'coder', objective: 'noop' });
    // coder uses mcp:true → allow-all → predicate is undefined (no filtering).
    expect(seenAllow).toBeUndefined();
  });
});

describe('skills are delivered to the sub-agent, filtered by its role (agent §2.3 / §3.6)', () => {
  let skillsDir: string;
  afterEach(() => {
    if (skillsDir) rmSync(skillsDir, { recursive: true, force: true });
  });

  function setupSkills(): void {
    skillsDir = mkdtempSync(join(tmpdir(), 'ea-e2e-skills-'));
    const write = (name: string, fm: string) => {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(join(skillsDir, name, 'SKILL.md'), `---\n${fm}\n---\nbody\n`, 'utf8');
    };
    write('summarize', 'name: summarize\ndescription: Summarize text'); // no tool requirement
    write('scaffold', 'name: scaffold\ndescription: Create files\nallowed-tools: [readFile, writeFile]');
  }

  it('a read-only researcher is offered only carryable skills (no writeFile skill)', async () => {
    setupSkills();
    const model = scriptedModel([{ text: 'done' }]);
    const h = harness({
      defaultModel: model,
      subAgentSkillCatalog: (toolNames) => new SkillRegistry([skillsDir]).catalog(toolNames),
    });
    await callDelegate(spawnSubAgentTool(h.parent), { role: 'researcher', objective: 'x' });
    const sys = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sys).toContain('summarize'); // no tool requirement → offered
    expect(sys).not.toContain('scaffold'); // needs writeFile → withheld from researcher
  });

  it('a generalist (full kit) is offered the write skill too', async () => {
    setupSkills();
    const model = scriptedModel([{ text: 'done' }]);
    const h = harness({
      defaultModel: model,
      subAgentSkillCatalog: (toolNames) => new SkillRegistry([skillsDir]).catalog(toolNames),
    });
    await callDelegate(spawnSubAgentTool(h.parent), { role: 'generalist', objective: 'x' });
    const sys = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(sys).toContain('summarize');
    expect(sys).toContain('scaffold'); // generalist has writeFile → carryable
  });
});

describe('approval passthrough surfaces the full chain to the host (agent §3.4)', () => {
  it('a sub-agent high-risk call emits tool-approval-required with sub agentId + parentAgentId', async () => {
    const model = scriptedModel([
      { tool: 'writeFile', input: { path: 'note.txt', content: 'hi' } },
      { text: 'wrote note.txt' },
    ]);
    const h = harness({ defaultModel: model, autoApprove: 'once' });
    await callDelegate(spawnSubAgentTool(h.parent), { role: 'coder', objective: 'write a note' });

    const req = h.gateRequests.find((r) => r.toolName === 'writeFile');
    expect(req).toBeTruthy();
    expect(req!.agentId).toMatch(/^sub-coder-/);
    expect(req!.parentAgentId).toBe('orch');

    // The same chain is on the emitted event the host/UI consumes.
    const evt = h.events.find((e) => e.kind === 'tool-approval-required') as any;
    expect(evt.agentId).toMatch(/^sub-coder-/);
    expect(evt.parentAgentId).toBe('orch');
  });
});

describe('grant inheritance: a sub-agent reuses the parent\'s delegated approval (agent §3.4 B)', () => {
  it('inheritScopedGrants reuses the parent agentScoped grant — no re-prompt', async () => {
    const h = harness({
      // If inheritance is broken the gate would emit and this reject would fail
      // the run fast (instead of the test hanging on an unanswered approval).
      autoApprove: 'reject',
    });
    const root = h.rootPaths[0]!;
    // The parent (orch) already holds an agentScoped writeFile grant for `root`.
    h.grants.add({ tool: 'writeFile', grantKey: root, agentId: 'orch', agentScoped: true });

    const model = scriptedModel([
      { tool: 'writeFile', input: { path: join(root, 'inherited.txt'), content: 'via inherited grant' } },
      { text: 'wrote inherited.txt' },
    ]);
    h.services.modelFor = () => model;

    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'coder',
      objective: 'write inherited.txt',
      inheritScopedGrants: true,
    });

    expect(res.output).toContain('inherited.txt');
    expect(readFileSync(join(root, 'inherited.txt'), 'utf8')).toBe('via inherited grant');
    // It never re-prompted: no writeFile approval request was emitted.
    expect(h.gateRequests.some((r) => r.toolName === 'writeFile')).toBe(false);
    // Audit shows both the delegation record and the auto-allowed actual write.
    const audit = h.audit.all();
    expect(audit.some((r) => r.approval === 'delegated' && r.tool === 'writeFile')).toBe(true);
    const writeExec = audit.find((r) => r.tool === 'writeFile' && r.approval === 'session-auto');
    expect(writeExec).toBeTruthy();
  });

  it('WITHOUT inheritScopedGrants the same write re-prompts (proving inheritance is opt-in)', async () => {
    const h = harness({ autoApprove: 'reject' });
    const root = h.rootPaths[0]!;
    h.grants.add({ tool: 'writeFile', grantKey: root, agentId: 'orch', agentScoped: true });
    const model = scriptedModel([
      { tool: 'writeFile', input: { path: join(root, 'blocked.txt'), content: 'x' } },
      { text: 'tried to write' },
    ]);
    h.services.modelFor = () => model;
    await callDelegate(spawnSubAgentTool(h.parent), { role: 'coder', objective: 'write blocked.txt' });
    // The agentScoped parent grant is NOT visible to the sub by default → prompt → reject.
    expect(h.gateRequests.some((r) => r.toolName === 'writeFile')).toBe(true);
  });
});

describe('the generalist role can do EVERYTHING in one run (the maximal-set proof)', () => {
  it('reads, runs a command, fetches the network, calls MCP, and writes — all as one sub-agent', async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('net-ok', { status: 200 });
    }) as typeof fetch;
    const mcpHit: string[] = [];
    const ping = tool({
      description: 'ping',
      inputSchema: z.object({ x: z.string() }),
      execute: async ({ x }) => {
        mcpHit.push(x);
        return { pong: x };
      },
    });
    try {
      const h = harness({ autoApprove: 'session', wrapMcpTools: () => ({ mcp__svc__ping: ping }) });
      const root = h.rootPaths[0]!;
      writeFileSync(join(root, 'src.txt'), 'source', 'utf8');
      const model = scriptedModel([
        { tool: 'readFile', input: { path: join(root, 'src.txt') } },
        { tool: 'runCommand', input: { command: 'node', args: ['-e', 'process.stdout.write("ran")'] } },
        { tool: 'httpFetch', input: { url: 'https://example.com/' } },
        { tool: 'mcp__svc__ping', input: { x: 'pong' } },
        { tool: 'writeFile', input: { path: join(root, 'out.txt'), content: 'all done' } },
        { text: 'read + ran + fetched + mcp + wrote' },
      ]);
      h.services.modelFor = () => model;

      const res = await callDelegate(spawnSubAgentTool(h.parent), {
        role: 'generalist',
        objective: 'exercise every capability',
      });

      expect(res.output).toContain('wrote');
      expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('all done');
      expect(fetched).toBe(true);
      expect(mcpHit).toEqual(['pong']);
      const tools = new Set(h.audit.all().map((r) => r.tool));
      expect(tools.has('runCommand')).toBe(true);
      expect(tools.has('writeFile')).toBe(true);
      expect(tools.has('httpFetch')).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the FULL orchestrator → delegate → sub-agent chain runs (capstone)', () => {
  it('the orchestrator calls delegateToSubAgent, the sub-agent runs, and the result flows back', async () => {
    // Orchestrator: delegate a coding task, then report. Sub (coder): write a
    // file, then summarize. Two distinct scripted models, keyed by role.
    const orch = scriptedModel([
      { tool: 'delegateToSubAgent', input: { role: 'coder', objective: 'write greeting.txt' } },
      { text: 'delegated and the sub-agent finished' },
    ]);
    const h = harness({
      autoApprove: 'session',
      modelFor: (role) =>
        role === 'orchestrator'
          ? orch
          : scriptedModel([
              { tool: 'writeFile', input: { path: 'greeting.txt', content: 'hello from the delegated sub-agent' } },
              { text: 'wrote greeting.txt' },
            ]),
    });

    const session = new RuntimeSession(h.services, h.store, {
      goal: 'demo',
      buildSkillCatalog: () => '',
      maxSteps: 10,
      compactRatio: 0.9,
      orchestratorModelRef: 'mock:mock-model',
    });

    const { completion } = session.send('please create a greeting file');
    await completion;

    // The delegation really spawned and ran a sub-agent.
    const start = h.events.find((e) => e.kind === 'sub-agent-start') as any;
    expect(start).toBeTruthy();
    expect(start.role).toBe('coder');
    expect(h.events.some((e) => e.kind === 'sub-agent-finish')).toBe(true);

    // The sub-agent actually wrote the file (inside the boundary).
    expect(readFileSync(join(h.rootPaths[0]!, 'greeting.txt'), 'utf8')).toBe('hello from the delegated sub-agent');

    // The orchestrator produced its final text and the turn finished cleanly.
    const finish = h.events.find((e) => e.kind === 'run-finish') as any;
    expect(finish.finishReason).not.toBe('error');
    const orchText = h.events
      .filter((e: any) => e.kind === 'text-delta' && e.agentId === 'orch')
      .map((e: any) => e.text)
      .join('');
    expect(orchText).toContain('sub-agent finished');
  });
});

describe('a sub-agent stuck on an unanswered approval is freed by its timeout (agent §2.3 pt.5)', () => {
  it('does NOT hang the orchestrator: the wall-clock timeout rejects the pending approval', async () => {
    // coder calls writeFile (high-risk → approval). With NO autoApprove the gate
    // stays pending. The sub-agent's combined abort signal = parent ∪
    // AbortSignal.timeout(50). Before the abort-aware gate, the pending approval
    // ignored that timeout, so the SDK's for-await over the sub stream never
    // advanced and the delegate call (and the orchestrator step awaiting it) hung
    // forever. Now the timeout settles the gate as reject and the run unwinds.
    const model = scriptedModel([
      { tool: 'writeFile', input: { path: 'blocked.txt', content: 'x' } },
      { text: 'unreachable before the timeout fires' },
    ]);
    const h = harness({ defaultModel: model, subAgentTimeoutMs: 50 }); // no autoApprove

    const res = await callDelegate(spawnSubAgentTool(h.parent), {
      role: 'coder',
      objective: 'write blocked.txt without approval',
    });

    // The call resolved (the assertion that matters: no hang) with a timeout result.
    expect(res.error).toBe('timeout');
    expect(res.timeoutMs).toBe(50);
    // The approval really was raised (and then abandoned by the timeout).
    expect(h.gateRequests.some((r) => r.toolName === 'writeFile')).toBe(true);
    // sub-agent-finish was emitted so the host/UI can tear the node down.
    expect(h.events.some((e) => e.kind === 'sub-agent-finish')).toBe(true);
  });
});

describe('a tool-only sub-agent fails soft, not silently (agent §2.3 pt.8)', () => {
  it('catches AI_NoOutputGeneratedError into a structured note instead of throwing', async () => {
    // A model that ALWAYS calls a tool and never emits text → the loop runs out
    // of steps with no assistant text → the SDK throws NoOutputGenerated, which
    // the runtime must catch and shape into a result with a `note`.
    const alwaysTool = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock',
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'tool-call', toolCallId: `c${Math.random()}`, toolName: 'getCurrentTime', input: '{}' });
            c.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
            c.close();
          },
        }),
      }),
    });
    const h = harness({ defaultModel: alwaysTool });
    const res = await callDelegate(spawnSubAgentTool(h.parent), { role: 'analyst', objective: 'loop forever' });
    expect(res.output).toBe('');
    expect(res.note).toBeTruthy();
    expect(res.steps).toBeGreaterThan(0);
  });
});
