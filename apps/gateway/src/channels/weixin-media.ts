/**
 * iLink media crypto (gateway §8.2). The one real foot-gun the spec calls out:
 * image `aeskey` is a 32-char hex string (16 raw bytes — decode as hex, NOT
 * base64), while file / voice / video `aes_key` is base64. Mixing them up yields
 * a 24-byte garbage key and a failed decrypt. Media is AES-128-ECB.
 */
import { createDecipheriv } from 'node:crypto';
import { ILINK_ITEM, type ILinkItem } from './weixin-ilink.js';

/** Resolve an item's AES key to its 16 raw bytes, honoring the hex/base64 split. */
export function parseAesKey(item: ILinkItem): Buffer | undefined {
  // Images carry `aeskey` as 32 hex chars (gateway §8.2).
  if (item.type === ILINK_ITEM.IMAGE && typeof item.aeskey === 'string') {
    const key = Buffer.from(item.aeskey, 'hex');
    return key.length === 16 ? key : undefined;
  }
  // File / voice / video carry `aes_key` as base64.
  if (typeof item.aes_key === 'string') {
    const key = Buffer.from(item.aes_key, 'base64');
    return key.length === 16 ? key : undefined;
  }
  // Some payloads still use `aeskey` even for non-images — try base64 as a fallback.
  if (typeof item.aeskey === 'string') {
    const key = Buffer.from(item.aeskey, 'base64');
    return key.length === 16 ? key : undefined;
  }
  return undefined;
}

/** AES-128-ECB decrypt (gateway §8.2). PKCS#7 padding, no IV. */
export function aesEcbDecrypt(cipher: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(cipher), decipher.final()]);
}
