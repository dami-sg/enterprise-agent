/**
 * Composer attachment helpers (renderer lib/attachments): classification by
 * mime/extension, pasted-image naming, the upload manifest wording the model
 * sees, and chunked base64 encoding.
 */
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  bytesToBase64,
  classifyAttachment,
  parseUploadManifest,
  pastedImageName,
} from '../src/renderer/src/lib/attachments.js';

describe('classifyAttachment', () => {
  it('detects images by mime and by extension', () => {
    expect(classifyAttachment('photo.bin', 'image/png')).toBe('image');
    expect(classifyAttachment('photo.PNG', '')).toBe('image');
    expect(classifyAttachment('pic.jpeg', '')).toBe('image');
    expect(classifyAttachment('anim.webp', '')).toBe('image');
  });

  it('detects pdf by mime and extension', () => {
    expect(classifyAttachment('doc.bin', 'application/pdf')).toBe('pdf');
    expect(classifyAttachment('Doc.PDF', '')).toBe('pdf');
  });

  it('everything else is a generic file (office docs, text, code)', () => {
    expect(classifyAttachment('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('file');
    expect(classifyAttachment('sheet.xlsx', '')).toBe('file');
    expect(classifyAttachment('deck.pptx', '')).toBe('file');
    expect(classifyAttachment('notes.md', 'text/markdown')).toBe('file');
    expect(classifyAttachment('main.ts', '')).toBe('file');
  });
});

describe('pastedImageName', () => {
  it('derives the extension from the mime type', () => {
    expect(pastedImageName('image/png', 1)).toBe('pasted-1.png');
    expect(pastedImageName('image/jpeg', 2)).toBe('pasted-2.jpg');
    expect(pastedImageName('', 3)).toBe('pasted-3.png');
  });
});

describe('buildManifest', () => {
  it('is empty with no uploads', () => {
    expect(buildManifest([], 0)).toBe('');
  });

  it('lists every uploaded path with size and mime, gateway wording', () => {
    const m = buildManifest(
      [
        { path: 'uploads/报告.docx', size: 2048, mime: 'application/msword' },
        { path: 'uploads/a.txt', size: 10 },
      ],
      0,
    );
    expect(m).toContain('用户上传了以下文件，需要时用工具读取：');
    expect(m).toContain('- ./uploads/报告.docx（2KB，application/msword）');
    expect(m).toContain('- ./uploads/a.txt（1KB）');
    expect(m.endsWith('\n\n')).toBe(true);
    expect(m).not.toContain('已随消息附上');
  });

  it('notes inlined media when present', () => {
    const m = buildManifest([{ path: 'uploads/p.png', size: 1024, mime: 'image/png' }], 1);
    expect(m).toContain('已随消息附上 1 个媒体供模型直接查看');
  });
});

describe('parseUploadManifest', () => {
  it('is the inverse of buildManifest: recovers files and the user text', () => {
    const text = buildManifest(
      [
        { path: 'uploads/报告.pdf', size: 30 * 1024, mime: 'application/pdf' },
        { path: 'uploads/a.txt', size: 10 },
      ],
      0,
    ) + '帮我总结这两个文件';
    const parsed = parseUploadManifest(text);
    expect(parsed).toBeDefined();
    expect(parsed!.files).toEqual([
      { path: 'uploads/报告.pdf', name: '报告.pdf', kb: 30, mime: 'application/pdf', kind: 'pdf' },
      { path: 'uploads/a.txt', name: 'a.txt', kb: 1, mime: undefined, kind: 'file' },
    ]);
    expect(parsed!.rest).toBe('帮我总结这两个文件');
  });

  it('drops the inline-media note and handles an empty rest', () => {
    const text = buildManifest([{ path: 'uploads/p.png', size: 1024, mime: 'image/png' }], 1);
    const parsed = parseUploadManifest(text);
    expect(parsed!.files).toHaveLength(1);
    expect(parsed!.files[0]!.kind).toBe('image');
    expect(parsed!.rest).toBe('');
  });

  it('parses the gateway dispatcher variant (wrapping parens, kind labels, blank separators)', () => {
    const text =
      '（已随消息附上 1 个媒体供模型直接查看。）\n\n' +
      '（用户上传了以下文件，需要时用工具读取：\n' +
      '- 文档：./uploads/M2U_20260711_2133.pdf（30KB，application/pdf）\n' +
      '）\n\n' +
      '转为markdown格式';
    const parsed = parseUploadManifest(text);
    expect(parsed!.files).toEqual([
      { path: 'uploads/M2U_20260711_2133.pdf', name: 'M2U_20260711_2133.pdf', kb: 30, mime: 'application/pdf', kind: 'pdf' },
    ]);
    expect(parsed!.rest).toBe('转为markdown格式');
  });

  it('returns undefined for plain messages, including ones that merely mention the wording', () => {
    expect(parseUploadManifest('普通消息')).toBeUndefined();
    expect(parseUploadManifest('')).toBeUndefined();
    expect(parseUploadManifest('我说：用户上传了以下文件，需要时用工具读取：\n- ./uploads/x（1KB）')).toBeUndefined();
    // Header with no entries — not a manifest.
    expect(parseUploadManifest('用户上传了以下文件，需要时用工具读取：\n没有列表')).toBeUndefined();
  });

  it('keeps user text that follows the manifest verbatim (multi-line)', () => {
    const text = buildManifest([{ path: 'uploads/a.pdf', size: 2048, mime: 'application/pdf' }], 0) + '第一行\n\n第二行';
    expect(parseUploadManifest(text)!.rest).toBe('第一行\n\n第二行');
  });
});

describe('bytesToBase64', () => {
  it('round-trips bytes larger than one 8k chunk', () => {
    const bytes = new Uint8Array(20000).map((_, i) => i % 251);
    const b64 = bytesToBase64(bytes);
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('encodes empty input to an empty string', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });
});
