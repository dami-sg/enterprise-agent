/**
 * WeChat iLink QR login (gateway §8.3). Runs the scan flow, then persists the
 * credential the gateway needs: the `bot_token` goes to the OS keychain (only a
 * `keyRef` ever touches config, §7), and `baseURL` / `accountId` are written to
 * `gateway.json`. Reuses the same keychain backend the CLI writes provider keys
 * with — the gateway only stores a reference.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeyStore } from '@dami-sg/agent';
import { ILinkClient, ILINK_DEFAULT_BASE } from '../channels/weixin-ilink.js';
import {
  loadGatewayConfig,
  saveGatewayConfig,
  type ChannelConfig,
  type GatewayConfig,
} from '../config/gateway-config.js';
import type { GatewayPaths } from '../config/paths.js';

export interface WeixinLoginOptions {
  keychain: KeyStore;
  paths: GatewayPaths;
  baseURL?: string;
  /** Override the account id; default derives from `ilink_bot_id`. */
  accountId?: string;
  /** Polling budget in ms (default 180s). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface WeixinLoginResult {
  accountId: string;
  baseURL: string;
  keyRef: string;
  ilinkBotId?: string;
  ilinkUserId?: string;
}

/** The keychain ref a WeChat account's bot token is stored under (gateway §7). */
export function weixinKeyRef(accountId: string): string {
  return `weixin-bot-token-${accountId}`;
}

export async function runWeixinLogin(opts: WeixinLoginOptions): Promise<WeixinLoginResult> {
  const log = opts.log ?? ((l: string) => process.stderr.write(l + '\n'));
  const client = new ILinkClient({ baseURL: opts.baseURL ?? ILINK_DEFAULT_BASE });

  log('正在获取登录二维码…');
  const qr = await client.getBotQrcode(3);
  if (!qr.qrcode) throw new Error('iLink 未返回二维码（get_bot_qrcode）。');

  // Render: print the encoded string (scan target) and dump the image for the
  // user to open — no QR-rendering dependency pulled in.
  if (qr.qrcode_img_content) {
    const file = join(tmpdir(), `ea-weixin-qr-${Date.now()}.png`);
    try {
      writeFileSync(file, decodeImage(qr.qrcode_img_content));
      log(`二维码图片已保存：${file}（用微信扫码）`);
    } catch {
      /* fall back to the string below */
    }
  }
  log(`二维码内容（备用，可手动生成）：${qr.qrcode}`);
  log('请使用微信扫码并确认登录…');

  const status = await pollConfirmed(client, qr.qrcode, opts.timeoutMs ?? 180_000, log);
  const result = completeWeixinLogin(
    { keychain: opts.keychain, paths: opts.paths, accountId: opts.accountId, baseURL: opts.baseURL },
    status,
  );

  log(`✓ 登录成功：accountId=${result.accountId}，baseURL=${result.baseURL}`);
  log(`  bot_token 已写入 keychain（keyRef=${result.keyRef}），gateway.json 已更新（仅引用，不含明文）。`);

  return result;
}

/** The status fields returned once a QR scan is confirmed (gateway §8.3). */
export interface WeixinConfirmedStatus {
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

/**
 * Finalize a confirmed login: write `bot_token` to the keychain and upsert the
 * `weixin` channel into `gateway.json` (gateway §8.3). Shared by the terminal
 * `weixin login` flow and the Web UI's async scan flow (which polls status
 * itself and hands the confirmed payload here).
 */
export function completeWeixinLogin(
  opts: { keychain: KeyStore; paths: GatewayPaths; accountId?: string; baseURL?: string },
  status: WeixinConfirmedStatus,
): WeixinLoginResult {
  if (!status.bot_token) throw new Error('登录已确认但未返回 bot_token。');
  const baseURL = status.baseurl ?? opts.baseURL ?? ILINK_DEFAULT_BASE;
  const accountId = opts.accountId ?? status.ilink_bot_id ?? 'default';
  const keyRef = weixinKeyRef(accountId);

  opts.keychain.set(keyRef, status.bot_token);
  upsertWeixinChannel(opts.paths.gatewayConfig, { accountId, baseURL, keyRef });

  return { accountId, baseURL, keyRef, ilinkBotId: status.ilink_bot_id, ilinkUserId: status.ilink_user_id };
}

async function pollConfirmed(
  client: ILinkClient,
  qrcode: string,
  timeoutMs: number,
  log: (l: string) => void,
): Promise<{ bot_token?: string; baseurl?: string; ilink_bot_id?: string; ilink_user_id?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const s = await client.getQrcodeStatus(qrcode);
    if (s.status && s.status !== lastStatus) {
      lastStatus = s.status;
      log(`扫码状态：${s.status}`);
    }
    if (s.status === 'confirmed') return s;
    await delay(2000);
  }
  throw new Error('扫码登录超时（未在限定时间内确认）。');
}

/** Decode a base64 (or data-URL) image string to bytes. */
function decodeImage(content: string): Buffer {
  const comma = content.indexOf(',');
  const b64 = content.startsWith('data:') && comma >= 0 ? content.slice(comma + 1) : content;
  return Buffer.from(b64, 'base64');
}

function upsertWeixinChannel(
  configFile: string,
  info: { accountId: string; baseURL: string; keyRef: string },
): void {
  const cfg: GatewayConfig = loadGatewayConfig(configFile);
  const existing = cfg.channels.find((c) => c.name === 'weixin' && c.accountId === info.accountId);
  if (existing) {
    existing.enabled = true;
    existing.baseURL = info.baseURL;
    existing.accountId = info.accountId;
    existing.token = { keyRef: info.keyRef };
  } else {
    const channel: ChannelConfig = {
      name: 'weixin',
      enabled: true,
      accountId: info.accountId,
      baseURL: info.baseURL,
      token: { keyRef: info.keyRef },
      session: { executionMode: 'auto' },
      group: 'disabled',
    };
    cfg.channels.push(channel);
  }
  saveGatewayConfig(configFile, cfg);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
