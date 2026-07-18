/**
 * Dispatcher (gateway §2.2 / §6). These drive the dispatcher against the fake
 * host + adapter and assert the host commands it issues — the gateway analogue
 * of headless-run.test.ts. The load-bearing case is the `turnRuns` invariant
 * (§2.2): an approval raised under a SUB-agent's runId must still be answered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStreamEvent, Artifact } from '@dami-sg/agent-contract';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { Router } from '../src/runtime/router.js';
import { InMemoryMemory } from '../src/memory/index.js';
import { FakeAdapter, FakeHost, inbound, tick } from './helpers.js';
import type { ChannelConfig } from '../src/config/gateway-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-disp-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function setup(adapter: FakeAdapter, config: Partial<ChannelConfig> = {}, opts: { maxConvs?: number } = {}) {
  const host = new FakeHost();
  const router = new Router(join(dir, 'routes.json'));
  let clock = 1_000_000;
  const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => clock++, maxConvs: opts.maxConvs });
  dispatcher.registerChannel(adapter, { name: adapter.name, ...config });
  return { host, router, dispatcher };
}

const subStart = (parentRunId: string, runId: string): AgentStreamEvent => ({
  kind: 'sub-agent-start',
  runId,
  parentRunId,
  parentAgentId: 'orch',
  agentId: 'sub-coder-1',
  role: 'coder',
  toolCallId: 'delegate-1',
});

const approvalEvent = (runId: string, toolCallId = 'w1'): AgentStreamEvent => ({
  kind: 'tool-approval-required',
  runId,
  agentId: 'a',
  toolCallId,
  toolName: 'writeFile',
  input: { path: 'out.txt' },
  grantScope: 'write files under out',
});

describe('routing (gateway §4)', () => {
  it('creates a session on the first message and reuses it on the next', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { host, dispatcher } = setup(tg);

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hello' }));
    expect(host.calls.startSession).toHaveLength(1);
    expect(host.calls.startSession[0]!.goal).toBe('hello');

    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-1', finishReason: 'stop' });
    await tick();

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'again' }));
    expect(host.calls.sendMessage).toEqual([{ sessionId: 's1', text: 'again' }]);
  });

  it('does not start a concurrent run while a turn is in flight', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'first' }));
    // No run-finish emitted → the turn is still active.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'second' }));
    expect(host.calls.sendMessage).toEqual([]); // the second message is held
    expect(tg.lastText()).toContain('正在处理');
  });

  it('injects scoped config and isolates the conversation into its own workspace subdir', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, {
      session: { workingDir: dir, executionMode: 'auto', permission: { allowHosts: ['api.internal'] } },
    });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hi' }));
    const input = host.calls.startSession[0]!;
    expect(input.workingDir).toBe(join(dir, 'c1')); // per-user file boundary
    expect(input.config).toEqual({ executionMode: 'auto', permission: { allowHosts: ['api.internal'] } });
  });

  it('gives different accounts different workspace dirs (per-user default)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir, executionMode: 'auto' } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'userA', text: 'hi' }));
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'userB', text: 'hi' }));
    expect(host.calls.startSession[0]!.workingDir).toBe(join(dir, 'userA'));
    expect(host.calls.startSession[1]!.workingDir).toBe(join(dir, 'userB'));
  });

  it('shared workspace mode uses the base dir for every account', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir }, workspace: 'shared' });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'userA', text: 'hi' }));
    expect(host.calls.startSession[0]!.workingDir).toBe(dir);
  });
});

describe('attachments → Route C (multimodal §8)', () => {
  it('saves an upload to <workdir>/uploads and prepends a manifest', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir, executionMode: 'auto' } });
    await dispatcher.handleInbound(
      'telegram',
      inbound({
        conversationId: 'c1',
        text: '看这个文件',
        attachments: [{ kind: 'file', data: Buffer.from('hello pdf'), filename: 'report.pdf', mimeType: 'application/pdf' }],
      }),
    );
    const goal = host.calls.startSession[0]!.goal;
    expect(goal).toContain('./uploads/report.pdf');
    expect(goal).toContain('看这个文件'); // user text preserved after the manifest
    const saved = join(dir, 'c1', 'uploads', 'report.pdf');
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, 'utf8')).toBe('hello pdf');
  });

  it('dedupes a same-named upload instead of clobbering', async () => {
    const tg = new FakeAdapter();
    const { dispatcher } = setup(tg, { session: { workingDir: dir } });
    const send = (data: string) =>
      dispatcher.handleInbound('telegram', inbound({ conversationId: 'c3', text: '', attachments: [{ kind: 'file', data: Buffer.from(data), filename: 'a.txt' }] }));
    await send('one');
    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-1', finishReason: 'stop' });
    await tick();
    await send('two');
    expect(readFileSync(join(dir, 'c3', 'uploads', 'a.txt'), 'utf8')).toBe('one');
    expect(readFileSync(join(dir, 'c3', 'uploads', 'a-1.txt'), 'utf8')).toBe('two');
  });

  it('notes when no workingDir is configured (cannot hand files to the agent)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, {});
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'c2', text: '', attachments: [{ kind: 'image', data: Buffer.from('img'), filename: 'p.jpg' }] }),
    );
    expect(host.calls.startSession[0]!.goal).toContain('未配置 workingDir');
  });

  it('transcribes a voice attachment via STT and inlines the text (multimodal §7)', async () => {
    const host = new FakeHost();
    const router = new Router(join(dir, 'routes.json'));
    const stt = { name: 'fake', transcribe: async () => '帮我查下明天的天气' };
    const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => 1, stt });
    dispatcher.registerChannel(new FakeAdapter(), { name: 'telegram', session: { workingDir: dir } });
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'cv', text: '', attachments: [{ kind: 'audio', voice: true, data: Buffer.from('OGG'), mimeType: 'audio/ogg', filename: 'voice.ogg' }] }),
    );
    const goal = host.calls.startSession[0]!.goal;
    expect(goal).toContain('语音转写');
    expect(goal).toContain('帮我查下明天的天气');
  });

  it('saves a non-voice audio file instead of transcribing it, even with STT on (multimodal §8)', async () => {
    const host = new FakeHost();
    const router = new Router(join(dir, 'routes.json'));
    let transcribed = false;
    const stt = { name: 'fake', transcribe: async () => ((transcribed = true), 'should not run') };
    const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => 1, stt });
    dispatcher.registerChannel(new FakeAdapter(), { name: 'telegram', session: { workingDir: dir } });
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'af', text: '听听这首歌', attachments: [{ kind: 'audio', data: Buffer.from('SONG'), filename: 'song.mp3' }] }),
    );
    expect(transcribed).toBe(false); // an audio file is not a voice note
    const goal = host.calls.startSession[0]!.goal;
    expect(goal).toContain('./uploads/song.mp3');
    expect(goal).not.toContain('语音转写');
    expect(existsSync(join(dir, 'af', 'uploads', 'song.mp3'))).toBe(true);
  });

  it('saves voice as a file when STT is not configured (no transcript)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir } }); // no stt
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'cv2', text: '', attachments: [{ kind: 'audio', voice: true, data: Buffer.from('OGG'), filename: 'voice.ogg' }] }),
    );
    const goal = host.calls.startSession[0]!.goal;
    expect(goal).toContain('./uploads/voice.ogg');
    expect(goal).not.toContain('语音转写');
  });

  it('passes an image through to a vision model (multimodal §3.2/§4)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { media: { image: 'passthrough' } });
    host.modelCaps = ['tool_call', 'image'];
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'i1', text: '这是什么？', attachments: [{ kind: 'image', data: Buffer.from('JPG'), mimeType: 'image/jpeg' }] }),
    );
    const parts = host.calls.startSession[0]!.parts as Array<{ type: string; mediaType?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
  });

  it('degrades an image to a saved file when the model lacks vision (§11)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { media: { image: 'passthrough' }, session: { workingDir: dir } });
    host.modelCaps = ['tool_call']; // no vision
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'i2', text: '', attachments: [{ kind: 'image', data: Buffer.from('JPG'), filename: 'p.jpg' }] }),
    );
    expect(host.calls.startSession[0]!.parts).toBeUndefined(); // not passed through
    expect(host.calls.startSession[0]!.goal).toContain('降级'); // §11 degrade note
    expect(existsSync(join(dir, 'i2', 'uploads', 'p.jpg'))).toBe(true);
  });

  it('passes an image through when the model is declared vision-capable, despite no detected vision (§3.1)', async () => {
    const tg = new FakeAdapter();
    // A multimodal model the catalog can't confirm: caps lack vision, but the
    // operator declared `media.modalities.image` → the gate must pass it through.
    const { host, dispatcher } = setup(tg, { media: { image: 'passthrough', modalities: { image: true } } });
    host.modelCaps = ['tool_call']; // detection says no vision
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'i3', text: '这是什么？', attachments: [{ kind: 'image', data: Buffer.from('JPG'), mimeType: 'image/jpeg' }] }),
    );
    const parts = host.calls.startSession[0]!.parts as Array<{ type: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
  });

  it('passes a PDF through to a pdf-capable model when configured', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { media: { pdf: 'passthrough' } });
    host.modelCaps = ['image', 'pdf'];
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'pp1', text: '总结一下', attachments: [{ kind: 'file', data: Buffer.from('PDF'), mimeType: 'application/pdf', filename: 'r.pdf' }] }),
    );
    const parts = host.calls.startSession[0]!.parts as Array<{ type: string; mediaType?: string }>;
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' });
  });

  it('pdf=auto passes a PDF through when the model is really pdf-capable (e.g. Anthropic)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { media: { pdf: 'auto' } });
    host.modelCaps = ['tool_call', 'pdf']; // catalog/builtin says pdf — transport carries it
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'pp3', text: '总结一下', attachments: [{ kind: 'file', data: Buffer.from('PDF'), mimeType: 'application/pdf', filename: 'r.pdf' }] }),
    );
    const parts = host.calls.startSession[0]!.parts as Array<{ type: string; mediaType?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' });
  });

  it('pdf=auto falls back to saving when the model is not pdf-capable', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { media: { pdf: 'auto' }, session: { workingDir: dir } });
    host.modelCaps = ['tool_call']; // no pdf, no declaration
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'pp4', text: '', attachments: [{ kind: 'file', data: Buffer.from('PDF'), mimeType: 'application/pdf', filename: 'r.pdf' }] }),
    );
    expect(host.calls.startSession[0]!.parts).toBeUndefined(); // saved, not passed through
    expect(existsSync(join(dir, 'pp4', 'uploads', 'r.pdf'))).toBe(true);
  });

  it('does NOT pass a PDF through on a declared-pdf openai-compatible model — degrades to Route C (regression)', async () => {
    const tg = new FakeAdapter();
    // A stale/forced pdf declaration must be ignored: the openai-compatible
    // transport can't carry an inline PDF (the endpoint errors), so the PDF must
    // go to the agent instead of being passed through.
    const { host, dispatcher } = setup(tg, { media: { pdf: 'passthrough', modalities: { pdf: true } }, session: { workingDir: dir } });
    host.modelCaps = ['tool_call', 'image']; // image ok, but no real pdf
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'pp5', text: '转换为markdown', attachments: [{ kind: 'file', data: Buffer.from('PDF'), mimeType: 'application/pdf', filename: 'r.pdf' }] }),
    );
    expect(host.calls.startSession[0]!.parts).toBeUndefined(); // not passed through
    expect(existsSync(join(dir, 'pp5', 'uploads', 'r.pdf'))).toBe(true); // saved for the agent
  });

  it('defaults PDF to Route C (saved for the agent), even on a pdf-capable model', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir } }); // media.pdf default 'agent'
    host.modelCaps = ['image', 'pdf'];
    await dispatcher.handleInbound(
      'telegram',
      inbound({ conversationId: 'pp2', text: '', attachments: [{ kind: 'file', data: Buffer.from('PDF'), mimeType: 'application/pdf', filename: 'r.pdf' }] }),
    );
    expect(host.calls.startSession[0]!.parts).toBeUndefined();
    expect(existsSync(join(dir, 'pp2', 'uploads', 'r.pdf'))).toBe(true);
  });
});

describe('approval bridge (gateway §6.1)', () => {
  it('answers a SUB-agent approval via the turn run tree (turnRuns invariant)', async () => {
    const wx = new FakeAdapter({ name: 'weixin' }); // no buttons
    const { host, dispatcher } = setup(wx, { approval: 'auto:session' });

    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(subStart('orch-1', 'sub-1'));
    dispatcher.handleEvent(approvalEvent('sub-1')); // raised under the SUB's runId
    await tick();

    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
  });

  it('ignores an approval from a run outside the turn tree (scoping)', async () => {
    const wx = new FakeAdapter({ name: 'weixin' });
    const { host, dispatcher } = setup(wx, { approval: 'auto:session' });
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('unrelated-run'));
    await tick();
    expect(host.calls.approveTool).toEqual([]);
  });

  it('renders inline buttons, resolves the tap, and finalizes the card in place', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true });
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();

    const card = tg.sends.find((s) => s.payload.kind === 'buttons');
    expect(card).toBeDefined();
    const payload = card!.payload;
    if (payload.kind !== 'buttons') throw new Error('expected a buttons card');
    const sessionBtn = payload.buttons[1]!; // [once][session][reject]

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', callbackData: sessionBtn.id }));
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
    // The card is edited in place: keyboard dropped (kind:'text') + outcome appended.
    const fin = tg.edits.find((e) => e.payload.kind === 'text' && e.payload.text.includes('本会话允许'));
    expect(fin).toBeDefined();
  });

  it('resolves an approval only once when the button is double-tapped concurrently', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true, resolvePrompt: true });
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();
    const token = tg.prompts[0]!.prompt.choices[1]!.id; // session

    // Two taps race (handleInbound is fire-and-forget in production).
    await Promise.all([
      dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', callbackData: token })),
      dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', callbackData: token })),
    ]);

    // The synchronous token claim means the host is only told once.
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
  });

  it('evicts the least-recently-seen idle conversation when over the cap', async () => {
    const tg = new FakeAdapter();
    const { dispatcher } = setup(tg, {}, { maxConvs: 2 });
    const convs = (dispatcher as unknown as { convs: Map<string, unknown> }).convs;

    for (const [c, run] of [
      ['c1', 'orch-1'],
      ['c2', 'orch-2'],
    ] as const) {
      await dispatcher.handleInbound('telegram', inbound({ conversationId: c, text: 'hi' }));
      dispatcher.handleEvent({ kind: 'run-finish', runId: run, finishReason: 'stop' });
      await tick();
    }
    expect(convs.size).toBe(2);

    // A third conversation trips the cap; the oldest idle conv (c1) is evicted,
    // never the just-created one.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c3', text: 'hi' }));
    expect(convs.size).toBe(2);
    expect(convs.has('telegram:c1')).toBe(false);
    expect(convs.has('telegram:c2')).toBe(true);
    expect(convs.has('telegram:c3')).toBe(true);
  });

  it('does not evict a conversation with an in-flight turn', async () => {
    const tg = new FakeAdapter();
    const { dispatcher } = setup(tg, {}, { maxConvs: 1 });
    const convs = (dispatcher as unknown as { convs: Map<string, unknown> }).convs;

    // c1's turn is still running (no run-finish) → not idle → must survive.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hi' }));
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c2', text: 'hi' }));
    expect(convs.has('telegram:c1')).toBe(true);
    expect(convs.has('telegram:c2')).toBe(true);
  });

  it('routes the approval through the channel prompt seam with its semantic kind', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();
    // The dispatcher does not assume inline buttons — it hands a semantic Prompt to
    // the adapter, which renders it however it can (gateway §6.1).
    expect(tg.prompts.map((p) => p.prompt.kind)).toEqual(['approval']);
    expect(tg.prompts[0]!.prompt.choices).toHaveLength(3); // once / session / reject
  });

  it('finalizes via the channel resolvePrompt when the adapter implements it', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true, resolvePrompt: true });
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();
    const sessionToken = tg.prompts[0]!.prompt.choices[1]!.id; // [once][session][reject]

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', callbackData: sessionToken }));
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
    // resolvePrompt owns finalization → it gets the body+outcome, and edit is NOT used.
    expect(tg.resolves).toHaveLength(1);
    expect(tg.resolves[0]!.finalText).toContain('本会话允许');
    expect(tg.edits.some((e) => e.payload.kind === 'text' && e.payload.text.includes('本会话允许'))).toBe(false);
  });

  it('falls back to a /approve text prompt under reject policy with no buttons', async () => {
    const wx = new FakeAdapter({ name: 'weixin' }); // no buttons, default reject policy
    const { host, dispatcher } = setup(wx);
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();

    expect(host.calls.approveTool).toEqual([]); // not auto-resolved
    expect(wx.lastText()).toContain('/approve');

    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: '/approve' }));
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
  });
});

describe('questions & plans (gateway §6.3)', () => {
  it('answers a numbered question reply', async () => {
    const wx = new FakeAdapter({ name: 'weixin' });
    const { host, dispatcher } = setup(wx);
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent({
      kind: 'user-question-required',
      runId: 'orch-1',
      agentId: 'orch',
      questionId: 'q1',
      questions: [
        { question: 'pick', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
      ],
    });
    await tick();
    expect(wx.lastText()).toContain('1. A');

    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: '2' }));
    expect(host.calls.answerQuestion).toEqual([{ questionId: 'q1', answers: [{ selected: ['B'] }] }]);
  });

  it('approves a plan via /approve', async () => {
    const wx = new FakeAdapter({ name: 'weixin' });
    const { host, dispatcher } = setup(wx);
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent({
      kind: 'plan-proposed',
      runId: 'orch-1',
      agentId: 'orch',
      planId: 'p1',
      plan: '1. do a thing',
    });
    await tick();
    expect(wx.lastText()).toContain('计划');

    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: '/approve' }));
    expect(host.calls.approvePlan).toEqual([{ planId: 'p1', decision: 'approve' }]);
  });

  it('routes a single-select question and a plan through the prompt seam on a button channel', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true });
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent({
      kind: 'user-question-required',
      runId: 'orch-1',
      agentId: 'orch',
      questionId: 'q1',
      questions: [{ question: 'pick', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await tick();
    expect(tg.prompts.map((p) => p.prompt.kind)).toEqual(['question']);
    const bToken = tg.prompts[0]!.prompt.choices[1]!.id;
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', callbackData: bToken }));
    expect(host.calls.answerQuestion).toEqual([{ questionId: 'q1', answers: [{ selected: ['B'] }] }]);

    dispatcher.handleEvent({ kind: 'plan-proposed', runId: 'orch-1', agentId: 'orch', planId: 'p1', plan: '1. do' });
    await tick();
    expect(tg.prompts.map((p) => p.prompt.kind)).toEqual(['question', 'plan']);
  });
});

describe('group authorization (gateway §6.4)', () => {
  it('only an admin may tap an approval button in a multi-user chat', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true, resolvePrompt: true });
    const { host, dispatcher } = setup(tg, { allowAdminFrom: ['admin1'] });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g1', userId: 'admin1', text: 'go' }));
    dispatcher.handleEvent(approvalEvent('orch-1'));
    await tick();
    const sessionToken = tg.prompts[0]!.prompt.choices[1]!.id; // [once][session][reject]

    // A non-admin bystander's tap is ignored (token not consumed).
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g1', userId: 'rando', callbackData: sessionToken }));
    expect(host.calls.approveTool).toEqual([]);

    // The admin's tap is honored.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g1', userId: 'admin1', callbackData: sessionToken }));
    expect(host.calls.approveTool).toEqual([{ toolCallId: 'w1', decision: 'session' }]);
  });

  it('lets the turn owner (a non-admin) answer its own question but blocks a bystander', async () => {
    const tg = new FakeAdapter({ buttons: true, edit: true, typing: true });
    const { host, dispatcher } = setup(tg, { allowAdminFrom: ['admin1'] });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g2', userId: 'owner', text: 'go' }));
    dispatcher.handleEvent({
      kind: 'user-question-required',
      runId: 'orch-1',
      agentId: 'orch',
      questionId: 'q1',
      questions: [{ question: 'pick', header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await tick();
    const bToken = tg.prompts[0]!.prompt.choices[1]!.id;

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g2', userId: 'rando', callbackData: bToken }));
    expect(host.calls.answerQuestion).toEqual([]);

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g2', userId: 'owner', callbackData: bToken }));
    expect(host.calls.answerQuestion).toEqual([{ questionId: 'q1', answers: [{ selected: ['B'] }] }]);
  });

  it('gives conversation ids that differ only in stripped characters distinct workspaces', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg, { session: { workingDir: dir } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'a.b', text: 'hi' }));
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'a_b', text: 'hi' }));
    const dirs = host.calls.startSession.map((s) => s.workingDir);
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs).size).toBe(2); // lossy `_`-replacement collapsed both to `a_b`
  });
});

describe('todo checklist (gateway §5)', () => {
  it('sends a rich checklist then edits it in place on an edit-capable channel', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent({
      kind: 'todo-update',
      sessionId: 's1',
      todos: [
        { id: '1', content: 'task A', status: 'in_progress' },
        { id: '2', content: 'task B', status: 'pending' },
      ],
    });
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('任务清单'))).toBe(true);

    dispatcher.handleEvent({
      kind: 'todo-update',
      sessionId: 's1',
      todos: [{ id: '1', content: 'task A', status: 'completed' }],
    });
    await tick();
    expect(tg.edits.some((e) => e.payload.kind === 'text' && e.payload.text.includes('~~task A~~'))).toBe(true);
  });

  it('skips the checklist on a no-edit channel (avoids spam)', async () => {
    const wx = new FakeAdapter({ name: 'weixin' });
    const { dispatcher } = setup(wx);
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent({
      kind: 'todo-update',
      sessionId: 's1',
      todos: [{ id: '1', content: 'x', status: 'pending' }],
    });
    await tick();
    expect(wx.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('任务清单'))).toBe(false);
  });
});

describe('artifact notices (gateway §5)', () => {
  const artifact = (overrides: Partial<Artifact> = {}) => ({
    id: 'a1',
    name: 'Q3 report',
    kind: 'document' as const,
    description: '季度营收汇总',
    path: 'out/q3.md',
    size: 1024,
    ...overrides,
  });

  it('routes artifact-created by sessionId and sends a short notice', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent({ kind: 'artifact-created', sessionId: 's1', artifact: artifact() });
    await tick();
    const notice = tg.sends.find((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'));
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).toContain('Q3 report — 季度营收汇总');
  });

  it('omits the dash when the artifact has no description', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent({ kind: 'artifact-created', sessionId: 's1', artifact: artifact({ description: undefined }) });
    await tick();
    const notice = tg.sends.find((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'));
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).toContain('Q3 report');
    expect((notice!.payload as { text: string }).text).not.toContain('—');
  });

  it('drops artifact-created for an unknown sessionId', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent({ kind: 'artifact-created', sessionId: 'other-session', artifact: artifact() });
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'))).toBe(false);
  });

  it('still delivers the notice after the turn finished (renderer torn down)', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-1', finishReason: 'stop' });
    await tick();

    dispatcher.handleEvent({ kind: 'artifact-created', sessionId: 's1', artifact: artifact() });
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'))).toBe(true);
  });

  it('attaches an image artifact as a native photo with the notice as caption', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg, { session: { workingDir: dir } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    writeFileSync(join(dir, 'c1', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    dispatcher.handleEvent({
      kind: 'artifact-created',
      sessionId: 's1',
      artifact: artifact({ kind: 'image', name: 'logo', path: 'logo.png', mimeType: 'image/png' }),
    });
    await tick();
    const sent = tg.sends.find((s) => s.payload.kind === 'media');
    expect(sent).toBeDefined();
    const p = sent!.payload as { media: { kind: string; filename?: string }; caption?: string };
    expect(p.media.kind).toBe('image');
    expect(p.media.filename).toBe('logo.png');
    expect(p.caption).toContain('已生成交付物');
  });

  it('inlines a small code artifact as a fenced block', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg, { session: { workingDir: dir } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    writeFileSync(join(dir, 'c1', 'hello.ts'), 'console.log(1)');

    dispatcher.handleEvent({
      kind: 'artifact-created',
      sessionId: 's1',
      artifact: artifact({ kind: 'code', name: 'hello.ts', path: 'hello.ts', description: undefined }),
    });
    await tick();
    const sent = tg.sends.find((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'));
    expect(sent).toBeDefined();
    expect((sent!.payload as { text: string }).text).toContain('```\nconsole.log(1)\n```');
    expect(tg.sends.some((s) => s.payload.kind === 'media')).toBe(false);
  });

  it('falls back to the bare notice when the file exceeds the upload ceiling', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg, { session: { workingDir: dir } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    writeFileSync(join(dir, 'c1', 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));

    dispatcher.handleEvent({
      kind: 'artifact-created',
      sessionId: 's1',
      artifact: artifact({ kind: 'image', name: 'big', path: 'big.png', mimeType: 'image/png' }),
    });
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'media')).toBe(false);
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'))).toBe(true);
  });

  it('attaches the file via the event absolutePath when no workspace is configured (scratch session)', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg); // no workingDir → gateway can't resolve artifact.path itself
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    const scratch = join(dir, 'scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'report.png'), Buffer.from([1, 2, 3]));

    dispatcher.handleEvent({
      kind: 'artifact-created',
      sessionId: 's1',
      artifact: artifact({ kind: 'image', name: 'report', path: 'report.png', mimeType: 'image/png' }),
      absolutePath: join(scratch, 'report.png'),
    });
    await tick();
    const sent = tg.sends.find((s) => s.payload.kind === 'media');
    expect(sent).toBeDefined();
    expect((sent!.payload as { media: { kind: string } }).media.kind).toBe('image');
  });

  it('refuses an artifact path that escapes the conversation workspace', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg, { session: { workingDir: dir } });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    writeFileSync(join(dir, 'outside.txt'), 'secret');

    dispatcher.handleEvent({
      kind: 'artifact-created',
      sessionId: 's1',
      artifact: artifact({ kind: 'code', name: 'outside', path: '../outside.txt' }),
    });
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'media')).toBe(false);
    const notice = tg.sends.find((s) => s.payload.kind === 'text' && s.payload.text.includes('已生成交付物'));
    expect(notice).toBeDefined();
    expect((notice!.payload as { text: string }).text).not.toContain('secret');
  });
});

describe('toolcall visibility (gateway §6.2, /toolcall)', () => {
  const toolCall = (): AgentStreamEvent => ({
    kind: 'tool-call',
    runId: 'orch-1',
    agentId: 'orch',
    toolCallId: 't1',
    toolName: 'writeFile',
    input: { path: 'x.md' },
  });

  it('hides tool-call lines by default', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(toolCall());
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('🔧 writeFile'))).toBe(false);
  });

  it('sends tool-call lines after /toolcall show and stops after /toolcall hide', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/toolcall show' }));
    expect(tg.lastText()).toContain('已开启');

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(toolCall());
    await tick();
    expect(tg.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('🔧 writeFile'))).toBe(true);

    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-1', finishReason: 'stop' });
    await tick();
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/toolcall hide' }));
    const before = tg.sends.length;
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'again' }));
    dispatcher.handleEvent({ ...toolCall(), runId: 'orch-2' });
    await tick();
    expect(
      tg.sends.slice(before).some((s) => s.payload.kind === 'text' && s.payload.text.includes('🔧 writeFile')),
    ).toBe(false);
  });

  it('replies with usage (and current state) on a bad argument', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/toolcall on' }));
    expect(tg.lastText()).toContain('用法：/toolcall show|hide');
    expect(tg.lastText()).toContain('hide');
  });
});

describe('sub-agent progress (gateway §2.3)', () => {
  const start = (): AgentStreamEvent => ({
    kind: 'sub-agent-start',
    runId: 'sub-1',
    parentRunId: 'orch-1',
    parentAgentId: 'orch',
    agentId: 'sub-coder-1',
    role: 'coder',
    toolCallId: 'd1',
  });
  const finish = (): AgentStreamEvent => ({
    kind: 'sub-agent-finish',
    runId: 'sub-1',
    agentId: 'sub-coder-1',
    summary: 'wrote auth.ts',
  });

  it('shows a live card and marks completion with summary on edit channels', async () => {
    const tg = new FakeAdapter({ edit: true, typing: true, buttons: true });
    const { dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'go' }));

    dispatcher.handleEvent(start());
    await tick();
    expect(
      tg.sends.some(
        (s) => s.payload.kind === 'text' && s.payload.text.includes('子代理进度') && s.payload.text.includes('coder'),
      ),
    ).toBe(true);

    dispatcher.handleEvent(finish());
    await tick();
    expect(
      tg.edits.some((e) => e.payload.kind === 'text' && e.payload.text.includes('- [x]') && e.payload.text.includes('wrote auth.ts')),
    ).toBe(true);
  });

  it('emits start/finish notices (not per-tool) on no-edit channels', async () => {
    const wx = new FakeAdapter({ name: 'weixin' });
    const { dispatcher } = setup(wx);
    await dispatcher.handleInbound('weixin', inbound({ channel: 'weixin', conversationId: 'c1', text: 'go' }));
    dispatcher.handleEvent(start());
    await tick();
    dispatcher.handleEvent(finish());
    await tick();
    expect(wx.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('启动'))).toBe(true);
    expect(
      wx.sends.some((s) => s.payload.kind === 'text' && s.payload.text.includes('完成') && s.payload.text.includes('wrote auth.ts')),
    ).toBe(true);
  });
});

describe('commands (gateway §6.2)', () => {
  it('/new unbinds the route and the next message starts a fresh session', async () => {
    const tg = new FakeAdapter();
    const { host, router, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hi' }));
    expect(router.lookup('telegram', 'c1')).toBeDefined();

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/new' }));
    expect(router.lookup('telegram', 'c1')).toBeUndefined();
    expect(host.calls.abortRun).toEqual(['orch-1']);

    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'fresh' }));
    expect(host.calls.startSession).toHaveLength(2);
  });

  it('/mode switches execution mode on the open session', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hi' }));
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/mode auto' }));
    expect(host.calls.setExecutionMode).toEqual([{ sessionId: 's1', mode: 'auto' }]);
  });

  it('/stop aborts the active run', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: 'hi' }));
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', text: '/stop' }));
    expect(host.calls.abortRun).toEqual(['orch-1']);
  });
});

describe('scheduled run delivery (§7 B.6)', () => {
  it('routes a schedule-finished summary to the deliver-to channel:conversation', async () => {
    const tg = new FakeAdapter(); // name 'telegram'
    const { host, dispatcher } = setup(tg);
    dispatcher.subscribe();
    host.emit({
      kind: 'schedule-finished',
      name: 'daily-digest',
      sessionId: 's1',
      runId: 'r1',
      status: 'done',
      summary: 'Yesterday: 3 PRs merged, 0 CI failures.',
      deliverTo: 'telegram:ops-group',
    });
    await tick();
    expect(tg.sends).toHaveLength(1);
    expect(tg.sends[0]!.target.conversationId).toBe('ops-group');
    expect(tg.lastText()).toContain('daily-digest');
    expect(tg.lastText()).toContain('3 PRs merged');
  });

  it('ignores delivery to an unknown channel (no throw, run already recorded)', async () => {
    const tg = new FakeAdapter();
    const { host, dispatcher } = setup(tg);
    dispatcher.subscribe();
    host.emit({
      kind: 'schedule-finished',
      name: 'x',
      sessionId: 's',
      runId: 'r',
      status: 'done',
      summary: 'hi',
      deliverTo: 'nosuch:conv',
    });
    await tick();
    expect(tg.sends).toHaveLength(0);
  });
});

describe('memory namespace injection (cross-channel-memory §3)', () => {
  // Bound: telegram:alice → acct_alice; everyone else unbound.
  const resolve = (provider: string, userId: string): string | undefined =>
    provider === 'telegram' && userId === 'alice' ? 'acct_alice' : undefined;

  function setupAcct(resolveAccount?: (p: string, u: string) => string | undefined) {
    const host = new FakeHost();
    const router = new Router(join(dir, 'routes.json'));
    const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => 1, resolveAccount });
    dispatcher.registerChannel(new FakeAdapter(), { name: 'telegram' });
    return { host, dispatcher };
  }

  it('bound user in a private chat → memoryNamespace = accountId', async () => {
    const { host, dispatcher } = setupAcct(resolve);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'alice', isPrivate: true, text: 'hi' }));
    expect(host.calls.startSession[0]!.config?.memoryNamespace).toBe('acct_alice');
  });

  it('group chat → no memoryNamespace even when the user is bound', async () => {
    const { host, dispatcher } = setupAcct(resolve);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g1', userId: 'alice', isPrivate: false, text: 'hi' }));
    expect(host.calls.startSession[0]!.config?.memoryNamespace).toBeUndefined();
  });

  it('unbound user in a private chat → no memoryNamespace', async () => {
    const { host, dispatcher } = setupAcct(resolve);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c2', userId: 'stranger', isPrivate: true, text: 'hi' }));
    expect(host.calls.startSession[0]!.config?.memoryNamespace).toBeUndefined();
  });

  it('no resolveAccount wired → no memoryNamespace (default off)', async () => {
    const { host, dispatcher } = setupAcct(undefined);
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c3', userId: 'alice', isPrivate: true, text: 'hi' }));
    expect(host.calls.startSession[0]!.config?.memoryNamespace).toBeUndefined();
  });
});

describe('memory governance commands (/memories, /forget, §5.4)', () => {
  const resolve = (provider: string, userId: string): string | undefined =>
    provider === 'telegram' && userId === 'alice' ? 'acct_alice' : undefined;

  function setupGov() {
    const host = new FakeHost();
    const router = new Router(join(dir, 'routes.json'));
    const memory = new InMemoryMemory();
    const tg = new FakeAdapter();
    const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => 1, resolveAccount: resolve, memory });
    dispatcher.registerChannel(tg, { name: 'telegram' });
    return { tg, dispatcher, memory };
  }

  const replyText = (tg: FakeAdapter): string =>
    tg.sends.filter((s) => s.payload.kind === 'text').map((s) => (s.payload as { text: string }).text).join('\n');

  it('/memories lists the caller’s own memories', async () => {
    const { tg, dispatcher, memory } = setupGov();
    await memory.capture({ namespace: 'acct_alice' }, { messages: [{ role: 'user', text: 'I love sci-fi' }] });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'alice', isPrivate: true, text: '/memories' }));
    expect(replyText(tg)).toContain('I love sci-fi');
  });

  it('/forget <id> deletes a memory', async () => {
    const { tg, dispatcher, memory } = setupGov();
    await memory.capture({ namespace: 'acct_alice' }, { messages: [{ role: 'user', text: 'delete me' }] });
    const id = (await memory.list({ namespace: 'acct_alice' }))[0]!.id;
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'alice', isPrivate: true, text: `/forget ${id}` }));
    expect(replyText(tg)).toContain('已删除');
    expect(await memory.list({ namespace: 'acct_alice' })).toHaveLength(0);
  });

  it('declines in a group chat — never leaks personal memory to a group (privacy)', async () => {
    const { tg, dispatcher, memory } = setupGov();
    await memory.capture({ namespace: 'acct_alice' }, { messages: [{ role: 'user', text: 'a secret' }] });
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'g1', userId: 'alice', isPrivate: false, text: '/memories' }));
    const out = replyText(tg);
    expect(out).not.toContain('a secret');
    expect(out).toContain('私聊');
  });

  it('declines for an unbound user', async () => {
    const { tg, dispatcher } = setupGov();
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'stranger', isPrivate: true, text: '/memories' }));
    expect(replyText(tg)).toContain('私聊');
  });

  it('shows the “remembering” perceptibility notice once per session', async () => {
    const { tg, dispatcher } = setupGov();
    const noticeCount = (): number =>
      tg.sends.filter((s) => s.payload.kind === 'text' && (s.payload as { text: string }).text.includes('记住')).length;

    // Turn 1 (session orch-1): a capture happens, then the turn finishes.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'alice', isPrivate: true, text: 'hi' }));
    dispatcher.handleEvent({ kind: 'memory-captured', sessionId: 's1', runId: 'orch-1', count: 2 });
    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-1', finishReason: 'stop' });
    await tick();
    expect(noticeCount()).toBe(1);

    // Turn 2 (same session): capture again → notice is NOT repeated.
    await dispatcher.handleInbound('telegram', inbound({ conversationId: 'c1', userId: 'alice', isPrivate: true, text: 'more' }));
    dispatcher.handleEvent({ kind: 'memory-captured', sessionId: 's1', runId: 'orch-2', count: 2 });
    dispatcher.handleEvent({ kind: 'run-finish', runId: 'orch-2', finishReason: 'stop' });
    await tick();
    expect(noticeCount()).toBe(1);
  });
});
