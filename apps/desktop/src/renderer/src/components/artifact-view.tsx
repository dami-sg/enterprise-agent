/**
 * Artifact preview rendering (desktop-app §artifacts), shared by the artifacts
 * side panel's inline needs and the standalone preview window. Classifies an
 * artifact by mime/extension and renders its bytes: images inline, PDF via a
 * blob-URL iframe (Chromium's native viewer), HTML in a sandboxed data-URL
 * iframe, markdown through react-markdown, everything else as source text.
 */
import { useEffect, useState } from 'react';
import type { Artifact } from '@dami-sg/agent-contract';
import { Markdown } from '@/components/Trace';

/** Decode base64 file bytes as UTF-8 text (markdown / source view). */
export function decodeUtf8(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Classify an artifact for preview by mime type + file extension. */
export function artifactTypes(artifact: Artifact) {
  const mime = artifact.mimeType ?? '';
  const path = artifact.path.toLowerCase();
  const isImage = artifact.kind === 'image' || mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(path);
  const isPdf = mime === 'application/pdf' || path.endsWith('.pdf');
  const isHtml = mime === 'text/html' || /\.html?$/.test(path);
  const isMd = mime === 'text/markdown' || /\.(md|markdown)$/.test(path);
  const isText =
    !isImage && !isPdf && (artifact.kind === 'document' || artifact.kind === 'code' || mime.startsWith('text/') || isHtml || isMd);
  return { isImage, isPdf, isHtml, isMd, isText, previewable: isImage || isPdf || isHtml || isMd || isText };
}

export type ArtifactTypes = ReturnType<typeof artifactTypes>;

/** True when the artifact has a meaningful text source to toggle to (md/html/text/
 *  code) — images and PDFs have no useful source view. */
export function hasSource(types: ArtifactTypes): boolean {
  return types.isMd || types.isHtml || (types.isText && !types.isImage && !types.isPdf);
}

/** Renders artifact content: HTML in a sandboxed data-URL iframe, PDF via a blob
 *  URL (native PDF viewer), images inline, markdown rendered, other text as
 *  source. */
export function ArtifactBody({
  artifact,
  types,
  base64,
  truncated,
}: {
  artifact: Artifact;
  types: ArtifactTypes;
  base64: string;
  truncated: boolean;
}) {
  const mime = artifact.mimeType ?? '';
  const [pdfUrl, setPdfUrl] = useState<string>();
  useEffect(() => {
    if (!types.isPdf) return;
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [base64, types.isPdf]);

  if (types.isImage) {
    return (
      <div className="p-4">
        <img src={`data:${mime || 'image/png'};base64,${base64}`} alt={artifact.name} className="mx-auto max-w-full" />
      </div>
    );
  }
  if (types.isPdf) {
    return pdfUrl ? <iframe title={artifact.name} src={pdfUrl} className="min-h-[70vh] w-full flex-1 border-0" /> : null;
  }
  if (types.isHtml) {
    return (
      <iframe
        title={artifact.name}
        sandbox="allow-scripts"
        src={`data:text/html;charset=utf-8;base64,${base64}`}
        className="min-h-[70vh] w-full flex-1 border-0 bg-white"
      />
    );
  }
  if (types.isMd) {
    return (
      <div className="p-4">
        <Markdown text={decodeUtf8(base64)} />
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words p-4 text-xs">
      {decodeUtf8(base64)}
      {truncated ? '\n…' : ''}
    </pre>
  );
}

/** Raw source view (decoded text) — used by the preview/source toggle for any
 *  text-backed artifact, including HTML and markdown. */
export function ArtifactSource({ base64, truncated }: { base64: string; truncated: boolean }) {
  return (
    <pre className="whitespace-pre-wrap break-words p-4 text-xs">
      {decodeUtf8(base64)}
      {truncated ? '\n…' : ''}
    </pre>
  );
}
