import type { UIMessage } from 'ai';
import { Bell } from 'lucide-react';
import type { ApprovalData, QuestionData } from '../../api';
import { ApprovalPrompt, QuestionPrompt } from './Prompts';
import type { AnyPart } from './Message';

/**
 * Pinned dock for the interactive run suspensions that NEED a decision — tool
 * approval and askUserQuestion. They're surfaced here, fixed just above the
 * composer, instead of inline in the transcript, so a parked run is impossible
 * to miss while scrolled up in long output (web-app §4.2). Plans stay inline
 * (long markdown reads better in place).
 */
export type PendingPrompt =
  | { kind: 'approval'; id: string; data: ApprovalData }
  | { kind: 'question'; id: string; data: QuestionData };

/** Collect the still-unresolved approval/question prompts from the message stream. */
export function collectPendingPrompts(messages: UIMessage[], resolved: ReadonlySet<string>): PendingPrompt[] {
  const out: PendingPrompt[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const p of m.parts as AnyPart[]) {
      if (p.type === 'data-approval') {
        const d = p.data as ApprovalData | undefined;
        if (d?.toolCallId && !resolved.has(d.toolCallId) && !seen.has(d.toolCallId)) {
          seen.add(d.toolCallId);
          out.push({ kind: 'approval', id: d.toolCallId, data: d });
        }
      } else if (p.type === 'data-question') {
        const d = p.data as QuestionData | undefined;
        if (d?.questionId && !resolved.has(d.questionId) && !seen.has(d.questionId)) {
          seen.add(d.questionId);
          out.push({ kind: 'question', id: d.questionId, data: d });
        }
      }
    }
  }
  return out;
}

export function PromptDock({
  prompts,
  onResolved,
}: {
  prompts: PendingPrompt[];
  onResolved: (id: string) => void;
}): React.ReactElement | null {
  if (prompts.length === 0) return null;
  return (
    <div className="fade-up mx-auto mb-2 w-full max-w-3xl rounded-2xl border bg-background p-2 shadow-lg ring-1 ring-border/50">
      <div className="flex items-center gap-1.5 px-1.5 pb-1.5 pt-0.5 text-xs font-medium text-muted-foreground">
        <Bell className="size-3.5 text-amber-500" />
        需要你的操作
      </div>
      <div className="space-y-2">
        {prompts.map((p) =>
          p.kind === 'approval' ? (
            <ApprovalPrompt key={p.id} data={p.data} onResolved={onResolved} />
          ) : (
            <QuestionPrompt key={p.id} data={p.data} onResolved={onResolved} />
          ),
        )}
      </div>
    </div>
  );
}
