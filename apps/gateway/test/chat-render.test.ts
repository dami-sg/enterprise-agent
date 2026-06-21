/**
 * ChatRenderer (gateway §5). Edit-capable channels stream by editing in place;
 * whole-message channels hold text until finish, keeping "typing…" alive in the
 * meantime. Long finals are split to the channel limit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConversationRenderer } from '../src/render/chat-render.js';
import { FakeAdapter } from './helpers.js';

const target = { conversationId: 'c1' };

afterEach(() => {
  vi.useRealTimers();
});

describe('whole-message channel (no edit)', () => {
  it('sends nothing mid-run, then the full text on finish', async () => {
    vi.useFakeTimers();
    const ch = new FakeAdapter({ typing: true }); // no edit
    const r = new ConversationRenderer(ch, target, { throttleMs: 100 });
    r.start();
    r.appendText('partial answer');
    await vi.advanceTimersByTimeAsync(250); // a couple of throttle ticks
    expect(ch.sends).toHaveLength(0); // held until finish
    expect(ch.typings.some((t) => t.on)).toBe(true); // typing kept warm

    vi.useRealTimers();
    await r.finish();
    expect(ch.sends).toHaveLength(1);
    expect(ch.sends[0]!.payload).toEqual({ kind: 'text', text: 'partial answer' });
    expect(ch.typings.some((t) => !t.on)).toBe(true); // typing dropped
  });

  it('splits an over-limit final into multiple sends', async () => {
    const ch = new FakeAdapter({ maxChars: 100 });
    const r = new ConversationRenderer(ch, target, {});
    r.start();
    r.appendText('x'.repeat(250));
    await r.finish();
    expect(ch.sends.length).toBeGreaterThan(1);
    for (const s of ch.sends) {
      if (s.payload.kind === 'text') expect(s.payload.text.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('edit-capable channel (streaming)', () => {
  it('sends the first chunk then edits in place as text grows', async () => {
    vi.useFakeTimers();
    const ch = new FakeAdapter({ edit: true, typing: true });
    const r = new ConversationRenderer(ch, target, { throttleMs: 100 });
    r.start();
    r.appendText('hello');
    await vi.advanceTimersByTimeAsync(150);
    expect(ch.sends).toHaveLength(1);
    expect(ch.sends[0]!.payload).toEqual({ kind: 'text', text: 'hello' });

    r.appendText(' world');
    await vi.advanceTimersByTimeAsync(150);
    expect(ch.edits.length).toBeGreaterThanOrEqual(1);
    expect(ch.edits.at(-1)!.payload).toEqual({ kind: 'text', text: 'hello world' });

    vi.useRealTimers();
    await r.finish();
  });
});

describe('error path', () => {
  it('surfaces a failure message and stops typing', async () => {
    const ch = new FakeAdapter({ typing: true });
    const r = new ConversationRenderer(ch, target, {});
    r.start();
    await r.fail('boom');
    expect(ch.lastText()).toContain('boom');
  });
});
