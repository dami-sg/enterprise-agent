/**
 * Tencent iLink Bot protocol client (gateway §8 / appendix B). The official
 * personal-WeChat Bot API (`https://ilinkai.weixin.qq.com`), pure HTTP/JSON,
 * usable standalone (no OpenClaw). This wraps the auth headers and the handful
 * of endpoints the adapter needs; the `ChannelAdapter` mapping lives in
 * weixin.ts. Field names for an undocumented API are centralized here so a
 * protocol tweak is a one-file change.
 */
import { randomInt } from 'node:crypto';

export const ILINK_DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
/** iLink long-poll holds ~35s (gateway §8.2). */
export const ILINK_LONGPOLL_MS = 35_000;
/** Protocol version sent in every `getupdates` (gateway appendix B). */
export const ILINK_CHANNEL_VERSION = '1.0.2';

/** iLink `item_list[].type` (gateway §8.2). */
export const ILINK_ITEM = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

export interface ILinkItem {
  type: number;
  content?: string;
  /** Media: CDN url + AES key (hex for images, base64 otherwise — §8.2). */
  url?: string;
  aeskey?: string;
  aes_key?: string;
  file_name?: string;
  [k: string]: unknown;
}

export interface ILinkMessage {
  msg_id?: string;
  from_user_id?: string; // `xxx@im.wechat`
  to_user_id?: string; // `xxx@im.bot`
  message_type?: number; // 1=user 2=bot
  context_token?: string;
  item_list?: ILinkItem[];
  [k: string]: unknown;
}

export interface GetUpdatesResult {
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QrcodeResult {
  qrcode?: string;
  qrcode_img_content?: string;
}

export interface QrcodeStatusResult {
  status?: string; // 'confirmed' when scanned + approved
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

export interface ILinkClientOptions {
  baseURL?: string;
  botToken?: string;
  fetchImpl?: typeof fetch;
}

export class ILinkClient {
  private readonly baseURL: string;
  private botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ILinkClientOptions = {}) {
    this.baseURL = (opts.baseURL ?? ILINK_DEFAULT_BASE).replace(/\/$/, '');
    this.botToken = opts.botToken ?? '';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  setBotToken(token: string): void {
    this.botToken = token;
  }

  // -- login (gateway §8.3 / appendix B) -----------------------------------

  getBotQrcode(botType = 3): Promise<QrcodeResult> {
    return this.get<QrcodeResult>(`/ilink/bot/get_bot_qrcode?bot_type=${botType}`);
  }

  getQrcodeStatus(qrcode: string): Promise<QrcodeStatusResult> {
    return this.get<QrcodeStatusResult>(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
  }

  // -- runtime (gateway §8.2) ----------------------------------------------

  /** Long-poll for new messages (~35s). The `get_updates_buf` cursor MUST be
   *  persisted and echoed back next call, else history is replayed (§8.5). */
  getUpdates(getUpdatesBuf: string): Promise<GetUpdatesResult> {
    return this.post<GetUpdatesResult>(
      '/ilink/bot/getupdates',
      { get_updates_buf: getUpdatesBuf, base_info: { channel_version: ILINK_CHANNEL_VERSION } },
      ILINK_LONGPOLL_MS + 5_000,
    );
  }

  /** Send a message. `context_token` MUST be the value from the inbound message,
   *  else the reply "succeeds" but never appears in the conversation (§8.2). */
  sendMessage(msg: ILinkMessage): Promise<unknown> {
    return this.post('/ilink/bot/sendmessage', { msg }, 15_000);
  }

  getConfig(): Promise<{ typing_ticket?: string }> {
    return this.post<{ typing_ticket?: string }>('/ilink/bot/getconfig', {}, 10_000);
  }

  sendTyping(toUserId: string, typingTicket: string): Promise<unknown> {
    return this.post(
      '/ilink/bot/sendtyping',
      { to_user_id: toUserId, typing_ticket: typingTicket },
      10_000,
    );
  }

  getUploadUrl(body: unknown): Promise<unknown> {
    return this.post('/ilink/bot/getuploadurl', body, 15_000);
  }

  // -- transport -----------------------------------------------------------

  /** Auth + anti-replay headers required on every request (gateway §8.2). */
  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': wechatUin(),
      Authorization: `Bearer ${this.botToken}`,
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseURL}${path}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    return this.unwrap<T>(res, path);
  }

  private async post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const res = await this.fetchImpl(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return this.unwrap<T>(res, path);
  }

  private async unwrap<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) throw new Error(`iLink ${res.status} ${path}`);
    return (await res.json()) as T;
  }
}

/** `X-WECHAT-UIN: base64(String(randomUint32()))`, regenerated per request (§8.2). */
export function wechatUin(): string {
  const n = randomInt(0, 0xffffffff) >>> 0;
  return Buffer.from(String(n), 'utf8').toString('base64');
}
