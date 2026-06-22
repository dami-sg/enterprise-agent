/**
 * Dispatcher (gateway §2.2 / §6). These drive the dispatcher against the fake
 * host + adapter and assert the host commands it issues — the gateway analogue
 * of headless-run.test.ts. The load-bearing case is the `turnRuns` invariant
 * (§2.2): an approval raised under a SUB-agent's runId must still be answered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { Dispatcher } from '../src/runtime/dispatcher.js';
import { Router } from '../src/runtime/router.js';
import { FakeAdapter, FakeHost, inbound, tick } from './helpers.js';
import type { ChannelConfig } from '../src/config/gateway-config.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gw-disp-'));
  return () => rmSync(dir, { recursive: true, force: true });
});

function setup(adapter: FakeAdapter, config: Partial<ChannelConfig> = {}) {
  const host = new FakeHost();
  const router = new Router(join(dir, 'routes.json'));
  const dispatcher = new Dispatcher({ host: host.asHost(), router, now: () => 1_000_000 });
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
    host.modelCaps = ['tools', 'vision'];
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
    host.modelCaps = ['tools']; // no vision
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
    host.modelCaps = ['tools']; // detection says no vision
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
    host.modelCaps = ['vision', 'pdf'];
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
    host.modelCaps = ['tools', 'pdf']; // catalog/builtin says pdf — transport carries it
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
    host.modelCaps = ['tools']; // no pdf, no declaration
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
    host.modelCaps = ['tools', 'vision']; // image ok, but no real pdf
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
    host.modelCaps = ['vision', 'pdf'];
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
