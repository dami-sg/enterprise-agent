import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Button } from '../ui/button';

interface Preview {
  name: string;
  isImage: boolean;
  url: string | null;
}

/**
 * The multimodal composer: a single rounded card holding the auto-growing
 * textarea, an attachment tray, the attach button, and a circular send/stop
 * button — the shape the Vercel AI Chatbot uses.
 */
export function Composer({
  input,
  setInput,
  files,
  setFiles,
  onSend,
  onStop,
  busy,
  canSend,
}: {
  input: string;
  setInput: (v: string) => void;
  files: FileList | undefined;
  setFiles: (f: FileList | undefined) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
}): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea up to a cap. We re-measure both when the text changes
  // and when the element's width settles — at first mount the textarea can be
  // laid out at ~0px wide (styles not yet applied), which inflates scrollHeight.
  const autosize = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, []);

  useLayoutEffect(autosize, [input, autosize]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === 'undefined') return;
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      // Only react to width changes; reacting to our own height mutations would loop.
      if (ta.clientWidth !== lastWidth) {
        lastWidth = ta.clientWidth;
        autosize();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [autosize]);

  const previews = useMemo<Preview[]>(
    () =>
      files
        ? Array.from(files).map((f) => ({
            name: f.name,
            isImage: f.type.startsWith('image/'),
            url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
          }))
        : [],
    [files],
  );
  useEffect(() => () => previews.forEach((p) => p.url && URL.revokeObjectURL(p.url)), [previews]);

  function clearFiles(): void {
    setFiles(undefined);
    if (fileRef.current) fileRef.current.value = '';
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onSend();
    }
  }

  return (
    <div className="relative mx-auto w-full max-w-3xl">
      <div className="relative flex flex-col gap-2 rounded-2xl border border-input bg-background p-2.5 shadow-sm transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15">
        {previews.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
            {previews.map((p, i) =>
              p.isImage && p.url ? (
                <img
                  key={i}
                  src={p.url}
                  alt={p.name}
                  title={p.name}
                  className="size-14 rounded-lg border object-cover"
                />
              ) : (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-muted px-2.5 py-1.5 text-xs text-muted-foreground"
                >
                  <Paperclip className="size-3.5" /> {p.name}
                </span>
              ),
            )}
            <button
              type="button"
              onClick={clearFiles}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="清除附件"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder="给 Agent 发消息…"
          className="max-h-[220px] w-full resize-none bg-transparent px-2 pt-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground"
        />

        <div className="flex items-center justify-between gap-2">
          <label
            className="inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="添加附件"
          >
            <Paperclip className="size-[18px]" />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.md"
              hidden
              onChange={(e) => setFiles(e.target.files ?? undefined)}
            />
          </label>

          {busy ? (
            <Button
              type="button"
              size="icon"
              onClick={onStop}
              className="size-8 rounded-full"
              title="停止生成"
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              onClick={onSend}
              disabled={!canSend}
              className="size-8 rounded-full"
              title="发送 (Enter)"
            >
              <ArrowUp className="size-[18px]" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
