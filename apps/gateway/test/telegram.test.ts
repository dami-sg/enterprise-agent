/**
 * Telegram adapter (gateway §9): long-poll normalization (message + callback)
 * and the inline-button send shape. Drives a stubbed `fetch` so no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TelegramAdapter } from '../src/channels/telegram.js';
import type { InboundMessage } from '../src/channels/adapter.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, body: unknown) => unknown): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const result = handler(String(url), body);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('inbound normalization', () => {
  it('maps a text message and a callback query, advancing the offset', async () => {
    const updates = [
      { update_id: 10, message: { message_id: 1, chat: { id: 555 }, from: { id: 42 }, text: 'hi' } },
      {
        update_id: 11,
        callback_query: { id: 'cb1', from: { id: 42 }, data: 't3', message: { message_id: 2, chat: { id: 555 } } },
      },
    ];
    const seenOffsets: number[] = [];
    stubFetch((url, body) => {
      if (url.endsWith('/getUpdates')) {
        const offset = (body as { offset: number }).offset;
        seenOffsets.push(offset);
        return offset === 0 ? updates : []; // first poll yields the batch, then idle
      }
      return {}; // answerCallbackQuery etc.
    });

    const adapter = new TelegramAdapter({ token: 'T', pollTimeoutSec: 0 });
    const got: InboundMessage[] = [];
    await adapter.start((m) => got.push(m));
    // Let a couple of poll cycles run.
    await new Promise((r) => setTimeout(r, 30));
    await adapter.stop();

    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ conversationId: '555', userId: '42', text: 'hi' });
    expect(got[1]).toMatchObject({ conversationId: '555', callbackData: 't3' });
    // Offset advanced past update_id 11 → next poll used 12.
    expect(seenOffsets).toContain(12);
  });
});

describe('outbound', () => {
  it('sends Markdown as Telegram HTML with parse_mode=HTML', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendMessage')) captured = body;
      return { message_id: 1 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.send({ conversationId: '9' }, { kind: 'text', text: '**bold** and `code` and <x>' });
    const body = captured as { parse_mode: string; text: string };
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('<b>bold</b> and <code>code</code> and &lt;x&gt;');
  });

  it('renders inline buttons as a reply_markup keyboard', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendMessage')) captured = body;
      return { message_id: 99 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    const ref = await adapter.send(
      { conversationId: '7' },
      { kind: 'buttons', text: 'approve?', buttons: [{ id: 'a', label: 'Allow' }, { id: 'r', label: 'Reject' }] },
    );
    expect(ref.messageId).toBe('99');
    const body = captured as { chat_id: string; reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(body.chat_id).toBe('7');
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(body.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe('a');
  });

  it('exposes the declared format transform (Markdown → Telegram HTML, gateway §5)', () => {
    const adapter = new TelegramAdapter({ token: 'T' });
    expect(adapter.format('**b** `c`')).toBe('<b>b</b> <code>c</code>');
  });

  it('edits in place as HTML with parse_mode=HTML (shared sendHtml path)', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/editMessageText')) captured = body;
      return { message_id: 1 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.edit({ conversationId: '9', messageId: '5' }, { kind: 'text', text: '**done**' });
    const body = captured as { parse_mode: string; text: string; message_id: number };
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toBe('<b>done</b>');
    expect(body.message_id).toBe(5);
  });

  it('renders an interactive prompt as an inline-keyboard card (gateway §6.1)', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendMessage')) captured = body;
      return { message_id: 12 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    const ref = await adapter.prompt(
      { conversationId: '7' },
      { kind: 'approval', text: 'approve?', choices: [{ id: 'once', label: 'Once' }, { id: 'no', label: 'Reject' }] },
    );
    expect(ref.messageId).toBe('12');
    const body = captured as { reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(body.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe('once');
  });
});
