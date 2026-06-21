/**
 * WeChat iLink protocol (gateway §8.2 / appendix B) and media crypto (§8.2).
 * Covers the auth headers, the getupdates body shape, and the image-vs-file AES
 * key foot-gun (hex vs base64).
 */
import { describe, it, expect } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  ILinkClient,
  ILINK_CHANNEL_VERSION,
  wechatUin,
  ILINK_ITEM,
} from '../src/channels/weixin-ilink.js';
import { parseAesKey, aesEcbDecrypt } from '../src/channels/weixin-media.js';

describe('wechatUin (gateway §8.2)', () => {
  it('is base64 of a decimal uint32 string', () => {
    const uin = wechatUin();
    const decoded = Buffer.from(uin, 'base64').toString('utf8');
    const n = Number(decoded);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(0xffffffff);
  });
  it('regenerates per call', () => {
    // Practically always distinct across a handful of draws.
    const set = new Set(Array.from({ length: 8 }, () => wechatUin()));
    expect(set.size).toBeGreaterThan(1);
  });
});

describe('ILinkClient transport', () => {
  function fakeFetch(captured: { url?: string; init?: RequestInit }) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.init = init;
      return new Response(JSON.stringify({ msgs: [], get_updates_buf: 'cursor-2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('sends the required auth headers on every request (§8.2)', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const client = new ILinkClient({ baseURL: 'https://x.test', botToken: 'TKN', fetchImpl: fakeFetch(cap) });
    await client.getUpdates('cursor-1');
    const headers = cap.init!.headers as Record<string, string>;
    expect(headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(headers['Authorization']).toBe('Bearer TKN');
    expect(typeof headers['X-WECHAT-UIN']).toBe('string');
    expect(cap.url).toBe('https://x.test/ilink/bot/getupdates');
  });

  it('puts the cursor + channel_version in the getupdates body (appendix B)', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const client = new ILinkClient({ baseURL: 'https://x.test', botToken: 'TKN', fetchImpl: fakeFetch(cap) });
    const res = await client.getUpdates('cursor-1');
    const body = JSON.parse(cap.init!.body as string);
    expect(body.get_updates_buf).toBe('cursor-1');
    expect(body.base_info.channel_version).toBe(ILINK_CHANNEL_VERSION);
    expect(res.get_updates_buf).toBe('cursor-2');
  });
});

describe('media AES (gateway §8.2)', () => {
  function encrypt(plain: Buffer, key: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  }

  it('decodes an image aeskey as hex (32 chars → 16 bytes) and round-trips', () => {
    const key = randomBytes(16);
    const plain = Buffer.from('hello image bytes');
    const cipher = encrypt(plain, key);
    const item = { type: ILINK_ITEM.IMAGE, aeskey: key.toString('hex') };
    const parsed = parseAesKey(item);
    expect(parsed).toBeDefined();
    expect(parsed!.length).toBe(16);
    expect(aesEcbDecrypt(cipher, parsed!).equals(plain)).toBe(true);
  });

  it('decodes a file aes_key as base64 (16 bytes)', () => {
    const key = randomBytes(16);
    const item = { type: ILINK_ITEM.FILE, aes_key: key.toString('base64') };
    const parsed = parseAesKey(item);
    expect(parsed?.equals(key)).toBe(true);
  });

  it('rejects a wrong-length key', () => {
    expect(parseAesKey({ type: ILINK_ITEM.IMAGE, aeskey: 'abcd' })).toBeUndefined();
  });
});
