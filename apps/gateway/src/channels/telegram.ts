/**
 * Telegram adapter (gateway §9) — the P0 full-capability reference: long-poll
 * `getUpdates` (no public ingress needed), streaming `editMessageText`, inline
 * keyboard approvals, and `typing`. Exercising every optional `ChannelAdapter`
 * method, it validates the abstraction's upper bound (WeChat §8 validates the
 * lower bound). Uses the global `fetch` — no SDK dependency.
 *
 * Rich text uses Telegram's Rich Messages (Bot API 10.x): the core's Markdown is
 * posted verbatim in `rich_message.markdown`. Rich Markdown is GFM-compatible, so
 * headings, tables, task lists, block quotes, spoilers, and fenced code render
 * natively — no Markdown→HTML conversion, and no `format` transform is declared
 * (absent ⇒ identity). A plain-text fallback guards older servers / bad content.
 *
 * The answer streams in place via `editMessageText`; while the agent is reasoning
 * we show an ephemeral `<tg-thinking>` indicator via `sendRichMessageDraft` so the
 * user sees activity instead of a silent gap.
 */
import { basename } from 'node:path';
import type {
  Attachment,
  ChannelAdapter,
  DraftContent,
  InboundMessage,
  MessageRef,
  OutboundPayload,
  Prompt,
  SendTarget,
} from './adapter.js';

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
  /** Present on a 429; `retry_after` is the cooldown in seconds (gateway §2.3). */
  parameters?: { retry_after?: number };
}

/** A Telegram API error carrying the HTTP / error_code so callers can classify it. */
class TgError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
  /** 'private' | 'group' | 'supergroup' | 'channel'. Only 'private' enters memory. */
  type?: string;
}
/** A downloadable Telegram file reference (document / audio / voice / video). */
interface TgFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
/** One size of a photo (Telegram sends an array of sizes, largest last). */
interface TgPhotoSize {
  file_id: string;
  file_size?: number;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  /** Caption on a media message (treated as the message text, gateway §3.2). */
  caption?: string;
  photo?: TgPhotoSize[];
  voice?: TgFileRef;
  audio?: TgFileRef;
  document?: TgFileRef;
  video?: TgFileRef;
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
  // Rich messages allow 32768 chars, but the plain-text fallback is a normal
  // message (4096), so we keep the conservative cap so a fallback never 400s.
  readonly maxChars = 4096;

  private readonly token: string;
  private readonly pollTimeoutSec: number;
  private readonly apiBase: string;
  private readonly onError: (err: unknown) => void;
  private running = false;
  private offset = 0;
  private loop?: Promise<void>;
  /** Epoch-ms until which Telegram has rate-limited us (429 `retry_after`, §2.3).
   *  All outbound calls wait this out instead of hammering the cooldown. */
  private rateLimitedUntil = 0;

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
      // Sit out an active 429 cooldown before polling, so we don't pile getUpdates
      // onto a rate limit (which only keeps it tripped).
      const cooldown = this.rateLimitedUntil - Date.now();
      if (cooldown > 0) {
        await delay(cooldown);
        continue;
      }
      try {
        const started = Date.now();
        const updates = await this.api<TgUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: this.pollTimeoutSec,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const u of updates ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const inbound = await this.toInbound(u); // media downloads happen here
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
        // Honor a 429 cooldown if one was just set; otherwise a plain backoff.
        const cd = this.rateLimitedUntil - Date.now();
        await delay(cd > 0 ? cd : 2000); // the runtime circuit breaker may also pause us (§2.3)
      }
    }
  }

  private async toInbound(u: TgUpdate): Promise<InboundMessage | undefined> {
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
        isPrivate: cq.message?.chat.type === 'private',
        text: '',
        callbackData: cq.data,
        callbackAckId: cq.id,
      };
    }
    const m = u.message;
    if (!m) return undefined;
    const text = m.text ?? m.caption ?? '';
    const attachments = await this.extractMedia(m); // downloads voice / photo / document … (§4)
    if (!text && !attachments) return undefined; // nothing usable
    return {
      channel: this.name,
      conversationId: String(m.chat.id),
      userId: String(m.from?.id ?? m.chat.id),
      isPrivate: m.chat.type === 'private',
      text,
      attachments,
    };
  }

  /** Normalize a message's media into downloaded `Attachment`s (gateway §3.2 / multimodal §4). */
  private async extractMedia(m: TgMessage): Promise<Attachment[] | undefined> {
    const out: Attachment[] = [];
    const add = async (
      ref: TgFileRef | undefined,
      kind: Attachment['kind'],
      opts: { fallbackName?: string; voice?: boolean } = {},
    ): Promise<void> => {
      if (!ref) return;
      const a = await this.downloadFile(ref.file_id, kind, ref.mime_type, ref.file_name ?? opts.fallbackName);
      if (a) {
        if (opts.voice) a.voice = true; // a voice note → transcribed via STT (multimodal §7)
        out.push(a);
      }
    };
    if (m.photo?.length) {
      // Telegram sends ascending sizes; the last is the largest. Photos are always
      // JPEG (Telegram re-encodes) and the size entries carry no mime_type — set it
      // so vision passthrough has a media type (multimodal §4).
      const largest = m.photo[m.photo.length - 1]!;
      await add({ file_id: largest.file_id, mime_type: 'image/jpeg' }, 'image', { fallbackName: 'photo.jpg' });
    }
    await add(m.voice, 'audio', { fallbackName: 'voice.ogg', voice: true });
    await add(m.audio, 'audio');
    await add(m.document, 'file');
    await add(m.video, 'video');
    return out.length ? out : undefined;
  }

  /** `getFile` → download the bytes (≤20MB bot limit, multimodal §4.1). A failed
   *  download is logged and dropped, never aborts the whole message. */
  private async downloadFile(
    fileId: string,
    kind: Attachment['kind'],
    mimeType?: string,
    filename?: string,
  ): Promise<Attachment | undefined> {
    try {
      const file = await this.api<{ file_path?: string }>('getFile', { file_id: fileId });
      const fp = file?.file_path;
      if (!fp) return undefined; // no path ⇒ too large (>20MB) or expired
      const res = await fetch(`${this.apiBase}/file/bot${this.token}/${fp}`);
      if (!res.ok) {
        this.onError(new TgError(`download ${kind}: HTTP ${res.status}`, res.status));
        return undefined;
      }
      return {
        kind,
        data: Buffer.from(await res.arrayBuffer()),
        mimeType,
        filename: filename ?? basename(fp),
      };
    } catch (err) {
      this.onError(err);
      return undefined;
    }
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef> {
    const chatId = target.conversationId;
    if (payload.kind === 'media') return this.sendMedia(chatId, payload);
    const replyMarkup =
      payload.kind === 'buttons'
        ? { inline_keyboard: payload.buttons.map((b) => [{ text: b.label, callback_data: b.id }]) }
        : undefined;
    const base: Record<string, unknown> = { chat_id: chatId };
    if (replyMarkup) base['reply_markup'] = replyMarkup;
    const m = await this.sendRich('sendRichMessage', base, payload.text);
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
    await this.sendRich(
      'editMessageText',
      { chat_id: ref.conversationId, message_id: Number(ref.messageId) },
      payload.text,
    );
  }

  /**
   * Show the `<tg-thinking>` phase indicator while the agent works (gateway §5,
   * sendRichMessageDraft). Drafts target a *private* chat only (group/channel ids
   * are negative), are ephemeral (~30s), and animate when re-sent with the same
   * `draft_id`; the turn's real answer (sent via `send`) supersedes the preview.
   * The `<tg-thinking>` block is valid only in a draft, never a persisted message.
   * Best-effort: a failed draft is logged, never thrown, so it can't stall the turn.
   */
  async draft(target: SendTarget, draftId: number, content: DraftContent): Promise<void> {
    if (this.rateLimited) return; // never add to a 429 cooldown
    const chatId = Number(target.conversationId);
    if (!Number.isInteger(chatId) || chatId <= 0) return; // drafts: private chats only
    const label = (content.status ?? '').trim() || 'Thinking…';
    try {
      await this.api('sendRichMessageDraft', {
        chat_id: chatId,
        draft_id: draftId,
        rich_message: { markdown: `<tg-thinking>${escapeTgHtml(label)}</tg-thinking>` },
      });
    } catch (err) {
      this.onError(err); // best-effort; the real answer is the source of truth
    }
  }

  /**
   * The single transport boundary for text (gateway §5, Telegram rich messages):
   * POST the core's Markdown verbatim in `rich_message.markdown`. Rich Markdown is
   * GFM-compatible, so headings, tables, task lists, block quotes, spoilers, and
   * fenced code all render natively with no conversion. If the server rejects the
   * rich message (older Bot API, or content it can't parse), retry once as a plain
   * `text` message so nothing is ever lost to a 400. Shared by `send` + `edit`.
   */
  private async sendRich(
    method: 'sendRichMessage' | 'editMessageText',
    base: Record<string, unknown>,
    markdown: string,
  ): Promise<TgMessage | undefined> {
    for (let attempt = 0; ; attempt++) {
      await this.awaitCooldown(); // never fire into an active 429 window
      try {
        return await this.api<TgMessage>(method, { ...base, rich_message: { markdown } });
      } catch (err) {
        const code = err instanceof TgError ? err.code : 0;
        const msg = (err as Error).message;
        if (/not modified/i.test(msg)) return undefined; // streaming edit re-sent identical text
        // Rate-limited: the cooldown is now set; wait it out and retry rather than
        // doubling the load with a fallback call. Bounded so we can't loop forever.
        if (code === 429 && attempt < 2) continue;
        // Transient (rate limit after retries / server error): give up; do NOT also
        // send a plain-text copy — that only adds to the flood.
        if (code === 429 || code >= 500) throw err;
        // Genuine content/method rejection → fall back once to plain text so the
        // message isn't lost (note: plain text is unformatted).
        this.onError(new Error(`${method} rejected, falling back to plain text: ${msg}`));
        const plain = method === 'sendRichMessage' ? 'sendMessage' : 'editMessageText';
        return await this.api<TgMessage>(plain, { ...base, text: markdown });
      }
    }
  }

  async typing(target: SendTarget, on: boolean): Promise<void> {
    // Telegram's chat action auto-expires (~5s); there is no "off". Only send on.
    if (!on || this.rateLimited) return; // skip the chat action during a 429 cooldown
    await this.api('sendChatAction', { chat_id: target.conversationId, action: 'typing' });
  }

  private async sendMedia(
    chatId: string,
    payload: Extract<OutboundPayload, { kind: 'media' }>,
  ): Promise<MessageRef> {
    const { media, caption } = payload;
    const [method, field] =
      media.kind === 'image'
        ? ['sendPhoto', 'photo']
        : media.kind === 'video'
          ? ['sendVideo', 'video']
          : ['sendDocument', 'document'];
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
      const code = json.error_code ?? res.status;
      if (code === 429) {
        // Park all outbound traffic until the cooldown clears (gateway §2.3).
        const retry = json.parameters?.retry_after ?? parseRetryAfter(json.description) ?? 5;
        this.rateLimitedUntil = Date.now() + retry * 1000;
      }
      throw new TgError(`telegram ${res.status}: ${json.description ?? 'request failed'}`, code);
    }
    return json.result;
  }

  /** Sleep until any active 429 cooldown clears (before a must-deliver call). */
  private async awaitCooldown(): Promise<void> {
    const wait = this.rateLimitedUntil - Date.now();
    if (wait > 0) await delay(wait);
  }

  /** Whether we're currently inside a 429 cooldown (skip best-effort calls). */
  private get rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape the HTML-significant chars in a `<tg-thinking>` label (markdown isn't
 *  parsed inside the block, so only `& < >` need escaping). */
function escapeTgHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pull the cooldown seconds out of a 429 description ("…retry after 9"). */
function parseRetryAfter(description?: string): number | undefined {
  const m = description ? /retry after (\d+)/i.exec(description) : null;
  return m ? Number(m[1]) : undefined;
}

/** Sleep until at least `minMs` has elapsed since `started`, if still running. */
async function floor(started: number, minMs: number, running: () => boolean): Promise<void> {
  const remaining = minMs - (Date.now() - started);
  if (remaining > 0 && running()) await delay(remaining);
}
