/**
 * Telegram adapter (gateway §9) — the P0 full-capability reference: long-poll
 * `getUpdates` (no public ingress needed), streaming `editMessageText`, inline
 * keyboard approvals, and `typing`. Exercising every optional `ChannelAdapter`
 * method, it validates the abstraction's upper bound (WeChat §8 validates the
 * lower bound). Uses the global `fetch` — no SDK dependency.
 */
import type {
  ChannelAdapter,
  InboundMessage,
  MessageRef,
  OutboundPayload,
  Prompt,
  SendTarget,
} from './adapter.js';
import { mdToTelegramHtml, htmlToPlain } from '../render/telegram-html.js';

export interface TelegramOptions {
  token: string;
  /** Long-poll timeout seconds (Telegram holds the request open). Default 30. */
  pollTimeoutSec?: number;
  /** API base override (testing). Default https://api.telegram.org. */
  apiBase?: string;
  onError?: (err: unknown) => void;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  readonly maxChars = 4096;

  /** Markdown → Telegram HTML (gateway §5). The one declared transform; `send` /
   *  `edit` apply it at the transport boundary and own the parse_mode + plain-text
   *  fallback. We deliberately avoid MarkdownV2 (its escaping makes 400s likely). */
  format(markdown: string): string {
    return mdToTelegramHtml(markdown);
  }

  private readonly token: string;
  private readonly pollTimeoutSec: number;
  private readonly apiBase: string;
  private readonly onError: (err: unknown) => void;
  private running = false;
  private offset = 0;
  private loop?: Promise<void>;

  constructor(opts: TelegramOptions) {
    this.token = opts.token;
    this.pollTimeoutSec = opts.pollTimeoutSec ?? 30;
    this.apiBase = opts.apiBase ?? 'https://api.telegram.org';
    this.onError = opts.onError ?? (() => {});
  }

  async start(onInbound: (m: InboundMessage) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loop = this.poll(onInbound);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
    this.loop = undefined;
  }

  private async poll(onInbound: (m: InboundMessage) => void): Promise<void> {
    while (this.running) {
      try {
        const started = Date.now();
        const updates = await this.api<TgUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeoutSec,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const inbound = this.toInbound(u);
          if (inbound) onInbound(inbound);
        }
        // Idle floor: long-poll normally blocks ~timeout seconds server-side, but
        // a fast-returning / misconfigured endpoint would otherwise spin the loop
        // and peg the CPU. Cap empty-poll frequency to ~1/s without adding latency
        // to a real long-poll (which takes seconds when empty).
        if ((updates?.length ?? 0) === 0) await floor(started, 1000, () => this.running);
      } catch (err) {
        if (!this.running) break;
        this.onError(err);
        await delay(2000); // backoff; the runtime circuit breaker may pause us (§2.3)
      }
    }
  }

  private toInbound(u: TgUpdate): InboundMessage | undefined {
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = cq.message?.chat.id;
      if (chatId === undefined) return undefined;
      // Ack immediately so the client stops its spinner; fire-and-forget.
      void this.api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      return {
        channel: this.name,
        conversationId: String(chatId),
        userId: String(cq.from.id),
        text: '',
        callbackData: cq.data,
        callbackAckId: cq.id,
      };
    }
    const m = u.message;
    if (!m || typeof m.text !== 'string') return undefined;
    return {
      channel: this.name,
      conversationId: String(m.chat.id),
      userId: String(m.from?.id ?? m.chat.id),
      text: m.text,
    };
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef> {
    const chatId = target.conversationId;
    if (payload.kind === 'media') return this.sendMedia(chatId, payload);
    const replyMarkup =
      payload.kind === 'buttons'
        ? { inline_keyboard: payload.buttons.map((b) => [{ text: b.label, callback_data: b.id }]) }
        : undefined;
    const m = await this.sendRich(chatId, payload.text, replyMarkup);
    return { conversationId: chatId, messageId: String(m?.message_id ?? '') };
  }

  /**
   * Render an interactive prompt as an inline-keyboard card (gateway §6.1). No
   * `resolvePrompt`: the Dispatcher's default `edit` (editMessageText drops the
   * keyboard and shows the outcome) is exactly the right finalization here.
   */
  async prompt(target: SendTarget, p: Prompt): Promise<MessageRef> {
    return this.send(target, { kind: 'buttons', text: p.text, buttons: p.choices });
  }

  async edit(ref: MessageRef, payload: OutboundPayload): Promise<void> {
    if (payload.kind !== 'text') return;
    await this.sendHtml(
      'editMessageText',
      { chat_id: ref.conversationId, message_id: Number(ref.messageId) },
      payload.text,
    );
  }

  /**
   * Send Markdown rendered as Telegram HTML (rich messages, gateway §5). The
   * converter guarantees well-formed HTML; this still keeps a plain-text fallback
   * if Telegram ever rejects the entities, so a message is never lost to a 400.
   */
  private async sendRich(
    chatId: string,
    markdown: string,
    replyMarkup?: unknown,
  ): Promise<TgMessage | undefined> {
    const base: Record<string, unknown> = { chat_id: chatId };
    if (replyMarkup) base['reply_markup'] = replyMarkup;
    return this.sendHtml('sendMessage', base, markdown);
  }

  /**
   * The single transport boundary for rich text (gateway §5): apply `format`
   * (Markdown → HTML) then POST with `parse_mode: HTML`, retrying once as plain
   * text if Telegram rejects the entities so a message is never lost to a 400.
   * Shared by both `send` (sendMessage) and `edit` (editMessageText).
   */
  private async sendHtml(
    method: 'sendMessage' | 'editMessageText',
    base: Record<string, unknown>,
    markdown: string,
  ): Promise<TgMessage | undefined> {
    const html = this.format(markdown);
    try {
      return await this.api<TgMessage>(method, { ...base, text: html, parse_mode: 'HTML' });
    } catch (err) {
      const msg = (err as Error).message;
      if (/not modified/i.test(msg)) return undefined; // streaming edit re-sent identical text
      if (!isParseError(msg)) throw err;
      return await this.api<TgMessage>(method, { ...base, text: htmlToPlain(html) });
    }
  }

  async typing(target: SendTarget, on: boolean): Promise<void> {
    // Telegram's chat action auto-expires (~5s); there is no "off". Only send on.
    if (!on) return;
    await this.api('sendChatAction', { chat_id: target.conversationId, action: 'typing' });
  }

  private async sendMedia(
    chatId: string,
    payload: Extract<OutboundPayload, { kind: 'media' }>,
  ): Promise<MessageRef> {
    const { media, caption } = payload;
    const method = media.kind === 'image' ? 'sendPhoto' : 'sendDocument';
    const field = media.kind === 'image' ? 'photo' : 'document';
    if (media.url) {
      const m = await this.api<TgMessage>(method, { chat_id: chatId, [field]: media.url, caption });
      return { conversationId: chatId, messageId: String(m?.message_id ?? '') };
    }
    // In-memory bytes → multipart upload.
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) form.set('caption', caption);
    const bytes = media.data ?? Buffer.alloc(0);
    form.set(field, new Blob([bytes], { type: media.mimeType ?? 'application/octet-stream' }), media.filename ?? 'file');
    const m = await this.apiForm<TgMessage>(method, form);
    return { conversationId: chatId, messageId: String(m?.message_id ?? '') };
  }

  private async api<T>(method: string, body: unknown): Promise<T | undefined> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((this.pollTimeoutSec + 10) * 1000),
    });
    return this.unwrap<T>(res);
  }

  private async apiForm<T>(method: string, form: FormData): Promise<T | undefined> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    return this.unwrap<T>(res);
  }

  private async unwrap<T>(res: Response): Promise<T | undefined> {
    const json = (await res.json()) as TgResponse<T>;
    if (!json.ok) {
      throw new Error(`telegram ${res.status}: ${json.description ?? 'request failed'}`);
    }
    return json.result;
  }
}

/** A Telegram 400 caused by unparseable HTML entities (→ plain-text fallback). */
function isParseError(msg: string): boolean {
  return /can't parse|parse entities|entities/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep until at least `minMs` has elapsed since `started`, if still running. */
async function floor(started: number, minMs: number, running: () => boolean): Promise<void> {
  const remaining = minMs - (Date.now() - started);
  if (remaining > 0 && running()) await delay(remaining);
}
