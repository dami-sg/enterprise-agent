/**
 * Minimal ZIP reader (gateway §7) — enough to unpack an uploaded skill bundle
 * without a third-party dependency. Supports the two methods skill zips use:
 * stored (0) and deflate (8, via Node's zlib), reading the central directory for
 * reliable sizes/offsets. No zip64. Rejects unsafe (absolute / `..`) entry paths.
 */
import { inflateRawSync } from 'node:zlib';

export interface UnzipEntry {
  path: string;
  data: Buffer;
}

const EOCD_SIG = 0x06054b50; // end of central directory
const CD_SIG = 0x02014b50; // central directory file header
const LFH_SIG = 0x04034b50; // local file header

// Decompression-bomb guardrails: a few-KB zip can inflate to gigabytes and
// exhaust memory. Cap per-entry and total uncompressed output, and the entry
// count, so a malicious skill bundle can't OOM the gateway (gateway §7).
const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // 64 MB per file
const MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MB per archive
const MAX_ENTRIES = 4096;

export function unzip(buf: Buffer): UnzipEntry[] {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('无效的 zip（找不到目录结尾记录）');
  const count = buf.readUInt16LE(eocd + 10);
  if (count > MAX_ENTRIES) throw new Error('zip 条目过多');
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries: UnzipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error('无效的 zip（目录项损坏）');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    assertSafePath(name);
    if (buf.readUInt32LE(localOff) !== LFH_SIG) throw new Error('无效的 zip（本地头损坏）');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    // `maxOutputLength` makes zlib abort a bomb mid-inflate instead of allocating
    // the full expansion; stored entries are bounded by the declared comp size.
    const data =
      method === 0
        ? Buffer.from(comp)
        : method === 8
          ? inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES })
          : undefined;
    if (!data) throw new Error(`不支持的 zip 压缩方式：${method}`);
    if (data.length > MAX_ENTRY_BYTES) throw new Error('zip 条目过大');
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('zip 解压后体积过大');
    entries.push({ path: name, data });
  }
  return entries;
}

/** Scan back from the end (over the ≤64KB comment) for the EOCD signature. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function assertSafePath(name: string): void {
  if (name.startsWith('/') || name.split(/[\\/]/).includes('..') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`不安全的 zip 路径：${name}`);
  }
}
