/**
 * Trace rendering (desktop-app §7, CLI-parity): recursively renders the CLI
 * trace tree — markdown assistant text, dim reasoning, collapsible tool calls
 * with status icons, nested sub-agent cards (delegate tools hold the sub's
 * trace in `children`, cli §3.1), compaction markers and shell escapes.
 */
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Loader2,
  ShieldAlert,
  SquareChevronRight,
  X,
  Zap,
} from 'lucide-react';
import type { AgentItem, CompactionItem, ShellItem, TextItem, ToolItem, TraceItem } from '@dami-sg/cli/trace';
import { fmtTok } from '@dami-sg/cli/trace';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/misc';
import { useT } from '@/lib/i18n';
import { cn, previewJson } from '@/lib/utils';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md text-[13px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
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
    default:
      return null;
  }
}

function TextBlock({ item }: { item: TextItem }) {
  if (item.speaker === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl rounded-br-sm bg-primary/15 border border-primary/20 px-3 py-2 whitespace-pre-wrap break-words text-[13px]">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.speaker === 'reasoning') {
    return (
      <div className="max-w-[92%] text-xs text-muted-foreground/80 italic whitespace-pre-wrap break-words border-l-2 border-border pl-2.5">
        {item.text}
      </div>
    );
  }
  return (
    <div className="max-w-[92%]">
      <Markdown text={item.text} />
    </div>
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

function ToolBlock({ item, depth }: { item: ToolItem; depth: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasSub = !!item.children?.length;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[92%]">
      <div className={cn('rounded-md border bg-card/60', item.status === 'error' && 'border-destructive/40')}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer hover:bg-accent/40 rounded-md">
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
        <CollapsibleContent>
          <div className="space-y-2 border-t px-2.5 py-2">
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
                  {previewJson(item.output)}
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
    <Card className="max-w-full border-primary/25 bg-primary/[0.04] p-2.5">
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
    <div className="max-w-[92%] rounded-md border bg-card/60 px-2.5 py-1.5 font-mono text-xs">
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
