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
