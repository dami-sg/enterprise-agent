/**
 * WeChat adapter over Tencent iLink (gateway §8). The weakest-capability channel
 * — no edit, no buttons, DM-only — and therefore the abstraction's stress test
 * (§3.3): it implements only `start` / `send` / `typing` / `stop`, so ChatRenderer
 * auto-degrades to whole-message sends and approvals fall to `/approve` text or
 * the auto policy (§8.4). Long-poll model is isomorphic to Telegram's getUpdates.
 */
import type {
  Attachment,
  ChannelAdapter,
  InboundMessage,
  MessageRef,
  OutboundPayload,
  SendTarget,
} from './adapter.js';
import {
  ILINK_ITEM,
  type ILinkClient,
  type ILinkItem,
  type ILinkMessage,
} from './weixin-ilink.js';
import { aesEcbDecrypt, parseAesKey } from './weixin-media.js';
import type { WeixinStateStore } from './weixin-state.js';
import { toPlainish } from '../render/markdown.js';

const BOT_MESSAGE_TYPE = 2;
const SEND_MESSAGE_STATE = 2;
/** Drop messages whose id we saw within this window (gateway §8.4 dedup). */
const DEDUP_WINDOW_MS = 5 * 60_000;

export interface WeixinOptions {
  client: ILinkClient;
  state: WeixinStateStore;
  accountId: string;
  /** iLink groups are basically unusable (§8.6); default 'disabled'. */
  group?: 'disabled' | 'enabled';
  now?: () => number;
  onError?: (err: unknown) => void;
  /** Logger for the group-enabled WARNING (§8.6). */
  warn?: (msg: string) => void;
}

export class WeixinAdapter implements ChannelAdapter {
  readonly name = 'weixin';
  readonly maxChars = 4000;
  // No `prompt` method → approvals / questions / plans degrade to text (§6.1/§8.4).

  /** Markdown → plain text (gateway §5/§8). WeChat has no rich text, so the one
   *  declared transform strips markup to a light plain-text layout; `send` applies it. */
  format(markdown: string): string {
    return toPlainish(markdown);
  }

  private readonly client: ILinkClient;
  private readonly state: WeixinStateStore;
  private readonly group: 'disabled' | 'enabled';
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly warn: (msg: string) => void;
  private readonly seen = new Map<string, number>();
  private typingTicket?: string;
  private running = false;
  private loop?: Promise<void>;

  constructor(opts: WeixinOptions) {
    this.client = opts.client;
    this.state = opts.state;
    this.group = opts.group ?? 'disabled';
    this.now = opts.now ?? (() => Date.now());
    this.onError = opts.onError ?? (() => {});
    this.warn = opts.warn ?? (() => {});
  }

  async start(onInbound: (m: InboundMessage) => void): Promise<void> {
    if (this.running) return;
    if (this.group === 'enabled') {
      this.warn('微信 iLink 群基本不可用（§8.6）：group=enabled 仅作尽力支持，建议仅做 1v1 助理 bot。');
    }
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
        const started = this.now();
        const res = await this.client.getUpdates(this.state.getCursor());
        // Persist the cursor BEFORE dispatching so a crash mid-batch never replays
        // the whole window (gateway §8.5).
        if (typeof res.get_updates_buf === 'string') this.state.setCursor(res.get_updates_buf);
        for (const msg of res.msgs ?? []) {
          const inbound = await this.toInbound(msg);
          if (inbound) onInbound(inbound);
        }
        // Idle floor (see telegram.ts): iLink long-poll holds ~35s, but defend
        // against a fast-returning endpoint pegging the CPU.
        if ((res.msgs?.length ?? 0) === 0) {
          const remaining = 1000 - (this.now() - started);
          if (remaining > 0 && this.running) await delay(remaining);
        }
      } catch (err) {
        if (!this.running) break;
        this.onError(err);
        await delay(2000);
      }
    }
  }

  private async toInbound(msg: ILinkMessage): Promise<InboundMessage | undefined> {
    // Only inbound user messages (type 1); ignore the bot's own echoes (§8.2).
    if (msg.message_type === BOT_MESSAGE_TYPE) return undefined;
    const conversationId = msg.from_user_id;
    if (!conversationId) return undefined;
    if (this.isDuplicate(msg.msg_id)) return undefined;

    if (msg.context_token) this.state.setContextToken(conversationId, msg.context_token);

    const text = textOf(msg.item_list);
    const attachments = await this.mediaOf(msg.item_list);

    return {
      channel: this.name,
      conversationId,
      userId: conversationId,
      // WeChat iLink is DM-only (from_user_id == conversationId), so every inbound
      // is a private 1:1 chat — mark it so the admin gate treats it as a personal bot.
      isPrivate: true,
      text,
      attachments: attachments.length ? attachments : undefined,
      raw: { contextToken: msg.context_token },
    };
  }

  async send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef> {
    const contextToken = this.contextTokenFor(target);
    // Buttons can't render on WeChat — flatten to text so nothing is lost (§8.4).
    const raw = payload.kind === 'text' ? payload.text : payload.kind === 'buttons' ? payload.text : (payload.caption ?? '');
    // core emits Markdown; WeChat has no rich text → light plain-text layout (§5/§8).
    const chunks = splitText(this.format(raw), this.maxChars);
    for (const chunk of chunks) {
      const msg: ILinkMessage = {
        to_user_id: target.conversationId,
        message_type: BOT_MESSAGE_TYPE,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: ILINK_ITEM.TEXT, content: chunk }],
        // message_state is required on send (gateway §8.2).
        message_state: SEND_MESSAGE_STATE,
      } as ILinkMessage;
      await this.client.sendMessage(msg);
    }
    return { conversationId: target.conversationId, messageId: '' };
  }

  async typing(target: SendTarget, on: boolean): Promise<void> {
    if (!on) return;
    try {
      if (!this.typingTicket) {
        const cfg = await this.client.getConfig();
        this.typingTicket = cfg.typing_ticket;
      }
      if (this.typingTicket) await this.client.sendTyping(target.conversationId, this.typingTicket);
    } catch (err) {
      this.onError(err);
    }
  }

  // -- helpers --

  private contextTokenFor(target: SendTarget): string | undefined {
    const raw = target.raw as { contextToken?: string } | undefined;
    return raw?.contextToken ?? this.state.getContextToken(target.conversationId);
  }

  private isDuplicate(msgId: string | undefined): boolean {
    if (!msgId) return false;
    const now = this.now();
    // Prune the sliding window.
    for (const [id, ts] of this.seen) {
      if (now - ts > DEDUP_WINDOW_MS) this.seen.delete(id);
    }
    if (this.seen.has(msgId)) return true;
    this.seen.set(msgId, now);
    return false;
  }

  private async mediaOf(items: ILinkItem[] | undefined): Promise<Attachment[]> {
    const out: Attachment[] = [];
    for (const item of items ?? []) {
      const kind = mediaKind(item.type);
      if (!kind || !item.url) continue;
      try {
        const data = await this.fetchAndDecrypt(item);
        out.push({ kind, data, filename: item.file_name, caption: item.content });
      } catch (err) {
        // Media decode is best-effort (gateway §8.2 foot-guns); never drop the
        // whole message because an attachment failed.
        this.onError(err);
      }
    }
    return out;
  }

  private async fetchAndDecrypt(item: ILinkItem): Promise<Buffer> {
    const res = await fetch(item.url!, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`weixin media ${res.status}`);
    // Cap the download: the CDN response is attacker-influenced (a crafted or
    // oversized attachment), and buffering it whole with no limit is a memory
    // DoS. Reject on the declared size early, then enforce the cap while reading.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) {
      throw new Error(`weixin media too large: ${declared} bytes`);
    }
    const cipher = await readCapped(res, MAX_MEDIA_BYTES);
    const key = parseAesKey(item);
    return key ? aesEcbDecrypt(cipher, key) : cipher;
  }
}

/** Max bytes to buffer for one inbound WeChat attachment (gateway §8.2). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/** Read a response body into a Buffer, aborting once it exceeds `cap` bytes. */
export async function readCapped(res: Response, cap: number): Promise<Buffer> {
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > cap) throw new Error(`weixin media too large: ${buf.byteLength} bytes`);
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > cap) throw new Error(`weixin media too large: exceeds ${cap} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Concatenate all text items into one string (gateway §8.2). */
function textOf(items: ILinkItem[] | undefined): string {
  return (items ?? [])
    .filter((i) => i.type === ILINK_ITEM.TEXT && typeof i.content === 'string')
    .map((i) => i.content as string)
    .join('\n')
    .trim();
}

function mediaKind(type: number | undefined): Attachment['kind'] | undefined {
  switch (type) {
    case ILINK_ITEM.IMAGE:
      return 'image';
    case ILINK_ITEM.VOICE:
      return 'audio';
    case ILINK_ITEM.FILE:
      return 'file';
    case ILINK_ITEM.VIDEO:
      return 'video';
    default:
      return undefined;
  }
}

/** WeChat has no Markdown; cap at maxChars on a paragraph/line boundary (§5/§8). */
function splitText(text: string, max: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= max) return [t];
  const chunks: string[] = [];
  let rest = t;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
