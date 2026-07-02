import type { UIMessage } from 'ai';
import { Brain, Check, Copy, Paperclip, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { PlanData, SubAgentData, TodosData } from '../../api';
import { Markdown } from '../../Markdown';
import { PlanPrompt } from './Prompts';
import { SubAgent } from './SubAgent';
import { TodoList } from './TodoList';

export interface AnyPart {
  type: string;
  text?: string;
  url?: string;
  mediaType?: string;
  filename?: string;
  data?: unknown;
}

/** Only render image URLs whose scheme is safe to put in `<img src>` (defense in
 *  depth: history parts are backend-trusted today, but keep this an allowlist). */
function safeImageSrc(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^(https?:|data:image\/|blob:)/i.test(url.trim()) ? url : undefined;
}

export function messageText(m: UIMessage): string {
  return (m.parts as AnyPart[])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('');
}

/** One conversation turn. User → right-aligned bubble; assistant → avatar + bare prose. */
export function Message({
  message,
  isLast,
  canRegenerate,
  onRegenerate,
}: {
  message: UIMessage;
  isLast: boolean;
  canRegenerate: boolean;
  onRegenerate: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const parts = message.parts as AnyPart[];
  const text = messageText(message);

  function copy(): void {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  }

  if (isUser) {
    return (
      <div className="group fade-up mx-auto flex w-full max-w-3xl justify-end px-4">
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          <div className="flex flex-wrap justify-end gap-2">
            {parts.filter((p) => p.type === 'file').map((p, i) => renderPart(p, i, 'user'))}
          </div>
          {text && (
            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] leading-relaxed">
              {text}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group fade-up mx-auto flex w-full max-w-3xl gap-4 px-4">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background ring-1 ring-border">
        <Sparkles className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 overflow-hidden">
        {parts.map((p, i) => renderPart(p, i, 'assistant'))}

        {text && (
          <div className="-ml-1.5 flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <ActionButton label={copied ? '已复制' : '复制'} onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </ActionButton>
            {isLast && canRegenerate && (
              <ActionButton label="重新生成" onClick={onRegenerate}>
                <RefreshCw className="size-3.5" />
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

function renderPart(p: AnyPart, i: number, role: string): React.ReactElement | null {
  switch (p.type) {
    case 'text':
      return role === 'assistant' ? (
        <Markdown key={i}>{p.text ?? ''}</Markdown>
      ) : (
        <span key={i}>{p.text}</span>
      );
    case 'reasoning':
      return (
        <details key={i} className="think group/think rounded-xl border bg-muted/40 text-sm">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-muted-foreground">
            <Brain className="size-3.5" />
            <span>思考过程</span>
            <span className="ml-auto text-xs transition-transform group-open/think:rotate-180">⌄</span>
          </summary>
          <div className="whitespace-pre-wrap px-3 pb-3 leading-relaxed text-muted-foreground">{p.text}</div>
        </details>
      );
    case 'file': {
      const imgSrc = (p.mediaType ?? '').startsWith('image/') ? safeImageSrc(p.url) : undefined;
      return imgSrc ? (
        <img
          key={i}
          src={imgSrc}
          alt={p.filename ?? ''}
          className="max-h-72 max-w-72 rounded-xl border object-cover"
        />
      ) : (
        <div
          key={i}
          className="inline-flex items-center gap-1.5 rounded-lg border bg-muted px-2.5 py-1.5 text-sm text-muted-foreground"
        >
          <Paperclip className="size-3.5" /> {p.filename ?? '附件'}
        </div>
      );
    }
    case 'data-memory': {
      const count = (p.data as { count?: number } | undefined)?.count;
      return (
        <div
          key={i}
          className="inline-flex items-center gap-1.5 rounded-full border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
        >
          🧠 已记入记忆{count ? ` · ${count} 条` : ''}
        </div>
      );
    }
    case 'data-tool': {
      const name = (p.data as { name?: string } | undefined)?.name;
      return (
        <div
          key={i}
          className="mr-1.5 inline-flex items-center gap-1.5 rounded-md border bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground"
        >
          🔧 {name ?? '工具调用'}
        </div>
      );
    }
    case 'data-todos':
      return <div key={i} className="my-1"><TodoList data={p.data as TodosData} /></div>;
    case 'data-subagent':
      return <div key={i} className="my-1"><SubAgent data={p.data as SubAgentData} /></div>;
    // approval / question are surfaced in the pinned PromptDock above the composer
    // (not inline), so a parked run isn't missed while scrolled up.
    case 'data-approval':
    case 'data-question':
      return null;
    case 'data-plan':
      return <div key={i} className="my-1"><PlanPrompt data={p.data as PlanData} /></div>;
    default:
      return null;
  }
}
