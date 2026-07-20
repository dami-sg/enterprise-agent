/**
 * Composer attachment pipeline (desktop-app §attachments): classify picked
 * files, read them to base64, and build the upload manifest. Every attachment
 * is persisted server-side into the session's `uploads/` dir via the
 * `session/uploadFile` RPC; images/PDFs are ADDITIONALLY inlined as UserParts
 * when the orchestrator model supports the modality (multimodal §3.1). The
 * routing mirrors the gateway's `ingestAttachments` semantics.
 *
 * Pure helpers first (vitest-friendly); only `fileToBase64` touches DOM types.
 */

/** Hard reject above this (matches the host's uploadFile cap). */
export const UPLOAD_MAX = 50 * 1024 * 1024;
/** Above these, the media is upload-only (no inline part) — spec advisory. */
export const INLINE_IMAGE_MAX = 5 * 1024 * 1024;
export const INLINE_PDF_MAX = 10 * 1024 * 1024;

export type AttachmentKind = 'image' | 'pdf' | 'file';

/** A file staged in the composer, not yet uploaded. */
export interface PendingAttachment {
  id: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  /** Object URL for image chip thumbnails — revoke on remove/send. */
  previewUrl?: string;
}

/** Classify by mime first, extension as fallback (same patterns as
 *  artifact-view's preview classification / the gateway's isPdf). */
export function classifyAttachment(name: string, mime: string): AttachmentKind {
  const lower = name.toLowerCase();
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(lower)) return 'image';
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  return 'file';
}

/** Filename for a pasted image (clipboard files often have no usable name). */
export function pastedImageName(mime: string, n: number): string {
  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? 'png');
  return `pasted-${n}.${ext}`;
}

/**
 * The text prefix describing this turn's uploads. Lists EVERY uploaded path
 * (inlined media too, so the agent can also read them later with tools), plus a
 * note when media went inline. Protocol text mirrors the gateway's wording and
 * intentionally stays Chinese (it addresses the model, not the user — no i18n).
 */
export function buildManifest(
  entries: Array<{ path: string; size: number; mime?: string }>,
  inlineCount: number,
): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    const kb = Math.max(1, Math.round(e.size / 1024));
    return `- ./${e.path}（${kb}KB${e.mime ? `，${e.mime}` : ''}）`;
  });
  const inline = inlineCount > 0 ? `（已随消息附上 ${inlineCount} 个媒体供模型直接查看。）\n` : '';
  return `${inline}用户上传了以下文件，需要时用工具读取：\n${lines.join('\n')}\n\n`;
}

/** One file recovered from a user message's upload-manifest prefix. */
export interface ManifestFile {
  /** Session-relative path (`uploads/<name>`). */
  path: string;
  name: string;
  /** Size in KB as printed in the manifest (approximate). */
  kb: number;
  mime?: string;
  kind: AttachmentKind;
}

/** A manifest entry line: `- ./uploads/x（30KB，application/pdf）`, with the
 *  gateway variant's optional kind label (`- 文档：./uploads/x（…）`). */
const MANIFEST_ENTRY = /^-\s*(?:[^：./（]{1,12}：)?\s*\.?\/?(.+?)（(\d+)KB(?:，([^）]+))?）$/;

/**
 * Recover the uploaded-file list from a user message that starts with the
 * upload manifest (the inverse of `buildManifest`, tolerant of the gateway
 * dispatcher's variant: wrapping `（…）` and per-line kind labels). The UI
 * renders the files as preview tiles and shows only `rest` as message text.
 * Returns undefined when the text carries no manifest.
 */
export function parseUploadManifest(text: string): { files: ManifestFile[]; rest: string } | undefined {
  const lines = text.split('\n');
  const files: ManifestFile[] = [];
  let i = 0;
  let sawManifest = false;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    // Blank separators between protocol blocks (and before the user text —
    // `rest` is trimmed anyway, so eating them here is harmless).
    if (line === '') {
      i++;
      continue;
    }
    // Inline-media note — protocol noise, dropped from display.
    if (/^（已随消息附上 \d+ 个媒体供模型直接查看。）$/.test(line)) {
      i++;
      continue;
    }
    if (/^（?用户上传了以下文件，需要时用工具读取：$/.test(line)) {
      sawManifest = true;
      i++;
      while (i < lines.length) {
        const m = MANIFEST_ENTRY.exec(lines[i]!.trim());
        if (!m) break;
        const path = m[1]!;
        const name = path.split('/').pop() ?? path;
        const mime = m[3];
        files.push({ path, name, kb: Number(m[2]), mime, kind: classifyAttachment(name, mime ?? '') });
        i++;
      }
      // The gateway variant closes the list with a lone `）`.
      if (i < lines.length && lines[i]!.trim() === '）') i++;
      continue;
    }
    // First real content line — everything from here on is the user's text.
    break;
  }
  if (!sawManifest || files.length === 0) return undefined;
  return { files, rest: lines.slice(i).join('\n').trim() };
}

/** Base64-encode raw bytes in 8k slices (a single spread would blow the call
 *  stack on multi-MB files). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(bin);
}

export async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}
