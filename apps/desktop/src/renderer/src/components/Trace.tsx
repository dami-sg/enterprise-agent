/**
 * Trace rendering (desktop-app §7, CLI-parity): recursively renders the CLI
 * trace tree — markdown assistant text, dim reasoning, collapsible tool calls
 * with status icons, nested sub-agent cards (delegate tools hold the sub's
 * trace in `children`, cli §3.1), compaction markers and shell escapes.
 */
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  FileCode2,
  FileText,
  Film,
  Image,
  Lightbulb,
  Loader2,
  Package,
  ShieldAlert,
  SquareChevronRight,
  X,
  Zap,
} from 'lucide-react';
import type { AgentItem, ArtifactItem, CompactionItem, ShellItem, TextItem, ToolItem, TraceItem } from '@dami-sg/cli/trace';
import { fmtTok } from '@dami-sg/cli/trace';
import { openArtifactPreviewById, openUrlInBrowser } from '@/store';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/misc';
import { useT } from '@/lib/i18n';
import { cn, previewJson } from '@/lib/utils';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md text-[13px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Transcript links open in the built-in browser window: the main window blocks
 *  all navigation (main §9.1), so a default `<a>` click silently does nothing. */
function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//i.test(href)) openUrlInBrowser(href);
      }}
    >
      {children}
    </a>
  );
}

export function TraceItems({ items, depth = 0 }: { items: TraceItem[]; depth?: number }) {
  return (
    <>
      {items.map((item, i) => (
        <TraceNode key={itemKey(item, i)} item={item} depth={depth} />
      ))}
    </>
  );
}

/** Stable-ish list key: tool/agent items carry ids; text blocks are positional
 *  (the reducer appends in order and mutates in place, so position IS identity). */
function itemKey(item: TraceItem, i: number): string {
  if (item.kind === 'tool') return `tool:${item.toolCallId}`;
  if (item.kind === 'agent') return `agent:${item.agentId}`;
  return `${item.kind}:${i}`;
}

function TraceNode({ item, depth }: { item: TraceItem; depth: number }) {
  switch (item.kind) {
    case 'text':
      return <TextBlock item={item} />;
    case 'tool':
      return <ToolBlock item={item} depth={depth} />;
    case 'agent':
      return <AgentBlock item={item} depth={depth} />;
    case 'compaction':
      return <CompactionBlock item={item} />;
    case 'shell':
      return <ShellBlock item={item} />;
    case 'artifact':
      return <ArtifactBlock item={item} />;
    default:
      return null;
  }
}

/** Human byte size. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactIcon(kind: string, className = 'size-4 shrink-0 text-primary') {
  switch (kind) {
    case 'image':
      return <Image className={className} aria-hidden />;
    case 'video':
      return <Film className={className} aria-hidden />;
    case 'code':
      return <FileCode2 className={className} aria-hidden />;
    case 'program':
      return <Package className={className} aria-hidden />;
    default:
      return <FileText className={className} aria-hidden />;
  }
}

/** Inline card shown in the transcript the moment an artifact is created;
 *  clicking opens the built-in-browser preview. */
function ArtifactBlock({ item }: { item: ArtifactItem }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => openArtifactPreviewById(item.id)}
      className="flex max-w-[92%] items-center gap-2.5 rounded-xl bg-primary/[0.06] px-3 py-2.5 text-left hover:bg-primary/10"
    >
      {artifactIcon(item.artifactKind)}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{item.name}</div>
        {item.description && <div className="truncate text-xs text-muted-foreground">{item.description}</div>}
        <div className="text-[11px] text-muted-foreground">
          {item.artifactKind} · {fmtBytes(item.size)}
        </div>
      </div>
      <span className="shrink-0 text-xs text-primary">{t('artifactOpen')}</span>
    </button>
  );
}

function TextBlock({ item }: { item: TextItem }) {
  if (item.speaker === 'user') {
    // Ollama-style: neutral gray bubble, right-aligned, generous rounding.
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-3xl bg-muted px-4 py-2.5 whitespace-pre-wrap break-words text-[13px]">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.speaker === 'reasoning') return <ReasoningBlock text={item.text} />;
  // Assistant: plain text, no bubble, full column width (Ollama-style).
  return <Markdown text={item.text} />;
}

/** Ollama-style folded reasoning: a "Thought" chip that expands to the raw
 *  thinking text. Collapsed by default so the transcript stays clean. */
function ReasoningBlock({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[92%]">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground">
        <Lightbulb className="size-3.5" />
        <span>{t('reasoningLabel')}</span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 whitespace-pre-wrap break-words border-l-2 border-border pl-2.5 text-xs italic text-muted-foreground/70">
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function toolStatusIcon(item: ToolItem) {
  switch (item.status) {
    case 'running':
      return <Loader2 className="size-3.5 animate-spin text-primary" />;
    case 'ok':
      return <Check className="size-3.5 text-success" />;
    case 'error':
      return <X className="size-3.5 text-destructive" />;
    case 'approval':
      return <ShieldAlert className="size-3.5 text-warning" />;
    case 'question':
      return <CircleHelp className="size-3.5 text-warning" />;
  }
}

/** Extract image content parts from an MCP tool result (e.g. browser screenshot):
 *  `{ content: [{ type:'image', data:<base64>, mimeType }] }`. */
function toolResultImages(output: unknown): Array<{ data: string; mimeType: string }> {
  const content = (output as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ data: string; mimeType: string }> = [];
  for (const c of content) {
    if (c && typeof c === 'object' && (c as { type?: string }).type === 'image' && typeof (c as { data?: unknown }).data === 'string') {
      out.push({ data: (c as { data: string }).data, mimeType: (c as { mimeType?: string }).mimeType ?? 'image/png' });
    }
  }
  return out;
}

/** Replace inline base64 image data with a short placeholder for the JSON preview. */
function stripImageData(output: unknown): unknown {
  const content = (output as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return output;
  return {
    ...(output as object),
    content: content.map((c) =>
      c && typeof c === 'object' && (c as { type?: string }).type === 'image' ? { ...(c as object), data: '<image>' } : c,
    ),
  };
}

function ToolBlock({ item, depth }: { item: ToolItem; depth: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasSub = !!item.children?.length;
  const images = toolResultImages(item.output);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[92%]">
      <div className={cn('rounded-xl bg-muted/50', item.status === 'error' && 'bg-destructive/10')}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left cursor-pointer hover:bg-accent/40 rounded-xl">
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          {toolStatusIcon(item)}
          <span className="font-mono text-xs font-medium">{item.toolName}</span>
          {item.grantScope && (
            <span className="truncate font-mono text-[11px] text-muted-foreground">{item.grantScope}</span>
          )}
          {item.auto && (
            <Badge variant={item.auto.verdict === 'allow' ? 'warning' : 'destructive'} title={item.auto.reason}>
              <Zap /> auto·{item.auto.verdict}
            </Badge>
          )}
          {hasSub && (
            <Badge variant="secondary">
              <Bot /> sub-agent
            </Badge>
          )}
        </CollapsibleTrigger>
        {/* Screenshots and other image results render inline, always visible. */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pb-2.5">
            {images.map((img, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: images have no stable id
              <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="tool result" className="max-h-96 max-w-full rounded-lg border" />
            ))}
          </div>
        )}
        <CollapsibleContent>
          <div className="space-y-2 px-3 pb-2.5 pt-0.5">
            {item.input !== undefined && item.input !== null && (
              <div>
                <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{t('input')}</div>
                <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono">
                  {previewJson(item.input)}
                </pre>
              </div>
            )}
            {item.output !== undefined && (
              <div>
                <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {item.isError ? t('errorOutput') : t('output')}
                </div>
                <pre
                  className={cn(
                    'max-h-64 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono',
                    item.isError && 'text-destructive',
                  )}
                >
                  {previewJson(images.length ? stripImageData(item.output) : item.output)}
                </pre>
              </div>
            )}
            {hasSub && (
              <div className="space-y-2">
                <TraceItems items={item.children!} depth={depth + 1} />
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Sub-agent card (cli §3.1): role header + live nested trace + summary. */
function AgentBlock({ item, depth }: { item: AgentItem; depth: number }) {
  // The orchestrator root is rendered by the transcript itself; only nested
  // sub-agent nodes reach here.
  return (
    <Card className="max-w-full border-0 bg-primary/[0.05] p-3">
      <div className="mb-1.5 flex items-center gap-2 text-xs">
        {item.status === 'running' ? (
          <Loader2 className="size-3.5 animate-spin text-primary" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
        <Bot className="size-3.5 text-primary" />
        <span className="font-medium">{item.role}</span>
        <span className="text-muted-foreground">{item.agentId}</span>
        {item.usage && <span className="ml-auto text-[11px] text-muted-foreground">{fmtTok(item.usage.totalTokens)} tok</span>}
      </div>
      <div className="space-y-2">
        <TraceItems items={item.children} depth={depth + 1} />
      </div>
      {item.summary && (
        <div className="mt-2 rounded bg-background/50 p-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {item.summary}
        </div>
      )}
    </Card>
  );
}

function CompactionBlock({ item }: { item: CompactionItem }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Separator className="flex-1" />
      <span>
        {item.done
          ? t('compacted', {
              before: item.tokensBefore ? fmtTok(item.tokensBefore) : '?',
              after: item.tokensAfter ? fmtTok(item.tokensAfter) : '?',
            })
          : t('compacting')}
      </span>
      <Separator className="flex-1" />
    </div>
  );
}

function ShellBlock({ item }: { item: ShellItem }) {
  return (
    <div className="max-w-[92%] rounded-xl bg-muted/50 px-3 py-2 font-mono text-xs">
      <div className="flex items-center gap-2">
        <SquareChevronRight className="size-3.5 text-muted-foreground" />
        <span>{item.command}</span>
        {item.running ? (
          <Loader2 className="size-3 animate-spin text-primary" />
        ) : (
          <span className={cn('text-[11px]', item.exitCode === 0 ? 'text-success' : 'text-destructive')}>
            exit {item.exitCode}
          </span>
        )}
      </div>
      {item.output && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{item.output}</pre>}
    </div>
  );
}
