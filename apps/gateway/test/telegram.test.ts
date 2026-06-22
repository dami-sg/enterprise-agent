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

describe('inbound media (multimodal §4)', () => {
  function jsonResp(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  it('downloads a document (caption → text) and a photo into attachments', async () => {
    const updates = [
      {
        update_id: 20,
        message: {
          message_id: 1,
          chat: { id: 555 },
          from: { id: 42 },
          caption: '看这个',
          document: { file_id: 'D1', file_name: 'report.pdf', mime_type: 'application/pdf' },
        },
      },
      {
        update_id: 21,
        message: { message_id: 2, chat: { id: 555 }, from: { id: 42 }, photo: [{ file_id: 'P_s' }, { file_id: 'P_lg' }] },
      },
    ];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/getUpdates')) {
        const offset = (init?.body ? JSON.parse(init.body as string) : {}).offset;
        return jsonResp({ ok: true, result: offset === 0 ? updates : [] });
      }
      if (u.endsWith('/getFile')) {
        const fileId = JSON.parse(init!.body as string).file_id;
        // largest photo size must be the one requested (P_lg, not P_s)
        const path = fileId === 'D1' ? 'documents/report.pdf' : fileId === 'P_lg' ? 'photos/big.jpg' : 'WRONG';
        return jsonResp({ ok: true, result: { file_path: path } });
      }
      if (u.includes('/file/botT/')) {
        const name = u.split('/').pop();
        return new Response(Buffer.from(`bytes:${name}`), { status: 200 });
      }
      return jsonResp({ ok: true, result: {} });
    }) as typeof fetch;

    const adapter = new TelegramAdapter({ token: 'T', pollTimeoutSec: 0 });
    const got: InboundMessage[] = [];
    await adapter.start((m) => got.push(m));
    await new Promise((r) => setTimeout(r, 40));
    await adapter.stop();

    expect(got).toHaveLength(2);
    // Document: caption becomes the text; bytes downloaded.
    expect(got[0]).toMatchObject({ conversationId: '555', userId: '42', text: '看这个' });
    const doc = got[0]!.attachments![0]!;
    expect(doc).toMatchObject({ kind: 'file', filename: 'report.pdf', mimeType: 'application/pdf' });
    expect(doc.data?.toString('utf8')).toBe('bytes:report.pdf');
    // Photo: largest size chosen, downloaded as an image.
    const photo = got[1]!.attachments![0]!;
    expect(photo.kind).toBe('image');
    expect(photo.data?.toString('utf8')).toBe('bytes:big.jpg');
  });

  it('drops a file that exceeds the 20MB limit (getFile returns no path) without losing the message', async () => {
    const updates = [
      { update_id: 30, message: { message_id: 1, chat: { id: 9 }, from: { id: 1 }, caption: 'big', document: { file_id: 'BIG' } } },
    ];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/getUpdates')) {
        const offset = (init?.body ? JSON.parse(init.body as string) : {}).offset;
        return jsonResp({ ok: true, result: offset === 0 ? updates : [] });
      }
      if (u.endsWith('/getFile')) return jsonResp({ ok: true, result: {} }); // no file_path → too big
      return jsonResp({ ok: true, result: {} });
    }) as typeof fetch;

    const adapter = new TelegramAdapter({ token: 'T', pollTimeoutSec: 0 });
    const got: InboundMessage[] = [];
    await adapter.start((m) => got.push(m));
    await new Promise((r) => setTimeout(r, 40));
    await adapter.stop();
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe('big');
    expect(got[0]!.attachments).toBeUndefined(); // download dropped, message still delivered
  });
});

describe('outbound', () => {
  it('sends the core Markdown verbatim as a rich message (rich_message.markdown)', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendRichMessage')) captured = body;
      return { message_id: 1 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    const text = '# Title\n\n**bold** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    await adapter.send({ conversationId: '9' }, { kind: 'text', text });
    const body = captured as { rich_message: { markdown: string }; parse_mode?: string };
    expect(body.parse_mode).toBeUndefined();
    expect(body.rich_message.markdown).toBe(text); // GFM passed through untouched
  });

  it('renders inline buttons as a reply_markup keyboard on the rich message', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendRichMessage')) captured = body;
      return { message_id: 99 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    const ref = await adapter.send(
      { conversationId: '7' },
      { kind: 'buttons', text: 'approve?', buttons: [{ id: 'a', label: 'Allow' }, { id: 'r', label: 'Reject' }] },
    );
    expect(ref.messageId).toBe('99');
    const body = captured as { chat_id: string; rich_message: { markdown: string }; reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> } };
    expect(body.chat_id).toBe('7');
    expect(body.rich_message.markdown).toBe('approve?');
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(body.reply_markup.inline_keyboard[0]![0]!.callback_data).toBe('a');
  });

  it('falls back to a plain text message when rich messages are rejected', async () => {
    const calls: string[] = [];
    let captured: unknown;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (u.endsWith('/sendRichMessage')) {
        return new Response(JSON.stringify({ ok: false, description: 'Bad Request: method not found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/sendMessage')) captured = body;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.send({ conversationId: '9' }, { kind: 'text', text: '# Title' });
    expect(calls.some((c) => c.endsWith('/sendRichMessage'))).toBe(true);
    expect((captured as { text: string }).text).toBe('# Title');
  });

  it('edits in place as a rich message (shared sendRich path)', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/editMessageText')) captured = body;
      return { message_id: 1 };
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.edit({ conversationId: '9', messageId: '5' }, { kind: 'text', text: '**done**' });
    const body = captured as { rich_message: { markdown: string }; message_id: number };
    expect(body.rich_message.markdown).toBe('**done**');
    expect(body.message_id).toBe(5);
  });

  it('shows the phase label inside a <tg-thinking> draft via sendRichMessageDraft', async () => {
    const drafts: Array<{ draft_id: number; rich_message: { markdown: string } }> = [];
    stubFetch((url, body) => {
      if (url.endsWith('/sendRichMessageDraft')) drafts.push(body as never);
      return true;
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.draft({ conversationId: '555' }, 7, { status: '🤖 Sub Agent running' });
    await adapter.draft({ conversationId: '555' }, 7, {}); // no status → default label
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.draft_id).toBe(7);
    expect(drafts[0]!.rich_message.markdown).toBe('<tg-thinking>🤖 Sub Agent running</tg-thinking>');
    expect(drafts[1]!.rich_message.markdown).toBe('<tg-thinking>Thinking…</tg-thinking>');
  });

  it('does not draft to non-private chats (group / channel ids are negative)', async () => {
    let called = false;
    stubFetch((url) => {
      if (url.endsWith('/sendRichMessageDraft')) called = true;
      return true;
    });
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.draft({ conversationId: '-1001234567' }, 7, { status: '🤔 Thinking…' });
    expect(called).toBe(false);
  });

  it('renders an interactive prompt as an inline-keyboard card (gateway §6.1)', async () => {
    let captured: unknown;
    stubFetch((url, body) => {
      if (url.endsWith('/sendRichMessage')) captured = body;
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

describe('rate limiting (429 / retry_after)', () => {
  function reply(status: number, json: unknown): Response {
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }

  it('on 429 it retries the rich message after the cooldown — never a plain-text copy', async () => {
    let richCalls = 0;
    let plainCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/sendRichMessage')) {
        richCalls++;
        if (richCalls === 1)
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 0', parameters: { retry_after: 0 } });
        return reply(200, { ok: true, result: { message_id: 5 } });
      }
      if (u.endsWith('/sendMessage')) plainCalls++;
      return reply(200, { ok: true, result: { message_id: 9 } });
    }) as typeof fetch;
    const adapter = new TelegramAdapter({ token: 'T' });
    const ref = await adapter.send({ conversationId: '9' }, { kind: 'text', text: '# hi' });
    expect(richCalls).toBe(2); // first 429, retried once after the cooldown
    expect(plainCalls).toBe(0); // never doubled with a plain-text fallback
    expect(ref.messageId).toBe('5');
  });

  it('skips drafts while inside a 429 cooldown (does not add to the flood)', async () => {
    let draftCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/sendRichMessageDraft')) {
        draftCalls++;
        return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } });
      }
      return reply(200, { ok: true, result: { message_id: 1 } });
    }) as typeof fetch;
    const adapter = new TelegramAdapter({ token: 'T' });
    await adapter.draft({ conversationId: '555' }, 7, { status: '🤔 Thinking…' }); // trips a 30s cooldown
    await adapter.draft({ conversationId: '555' }, 7, { status: '🤔 Thinking…' }); // skipped
    expect(draftCalls).toBe(1);
  });
});
