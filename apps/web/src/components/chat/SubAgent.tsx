import { Bot, Check, ChevronRight, Loader, Wrench } from 'lucide-react';
import type { SubAgentData } from '../../api';
import { cn } from '../../lib/utils';

/**
 * A delegated sub-agent's live progress card (agent §2.3). Streamed as
 * `data-subagent` and reconciled in place, so it flips running → done and grows
 * its activity list as the sub-agent works. Collapsed by default; click to expand
 * the execution process (the tool calls it made) and its final summary.
 */
export function SubAgent({ data }: { data: SubAgentData }): React.ReactElement {
  const running = data.status === 'running';
  const activity = data.activity ?? [];
  return (
    <details className="group/sa rounded-xl border bg-muted/40 text-sm" open={running}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2.5">
        <Bot className="size-4 shrink-0 text-violet-500" />
        <span className="font-medium">子代理</span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{data.role}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {running ? (
            <>
              <Loader className="size-3.5 animate-spin text-sky-500" />
              运行中{activity.length > 0 && ` · ${activity.length} 步`}
            </>
          ) : (
            <>
              <Check className="size-3.5 text-foreground" />
              已完成{activity.length > 0 && ` · ${activity.length} 步`}
            </>
          )}
          <ChevronRight className="size-3.5 transition-transform group-open/sa:rotate-90" />
        </span>
      </summary>
      <div className="space-y-2 px-3.5 pb-3">
        {activity.length > 0 ? (
          <ul className="space-y-1">
            {activity.map((tool, i) => (
              <li key={i} className="flex items-center gap-2 text-muted-foreground">
                <Wrench className="size-3 shrink-0" />
                <code className="font-mono text-xs">{tool}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">{running ? '正在启动…' : '无工具调用'}</p>
        )}
        {data.summary && (
          <div className={cn('rounded-lg border bg-background p-2.5 text-[13px] leading-relaxed', activity.length === 0 && 'mt-0')}>
            {data.summary}
          </div>
        )}
      </div>
    </details>
  );
}
