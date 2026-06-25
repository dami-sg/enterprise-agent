import { Check, CircleHelp, ClipboardList, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import {
  respondApproval,
  respondPlan,
  respondQuestion,
  type ApprovalData,
  type ApprovalDecision,
  type PlanData,
  type QuestionData,
} from '../../api';
import { Markdown } from '../../Markdown';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

/**
 * Interactive in-chat prompts for run suspensions (web-app §4.2). The agent core
 * still owns the security invariant (three-state approval, plan gate); these only
 * render the gate and POST the decision to /api/respond. Once resolved they
 * collapse to a compact receipt so the transcript stays readable.
 */

type Status = 'idle' | 'submitting' | 'resolved' | 'error';

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="rounded-xl border bg-muted/40 p-3.5 text-sm">
      <div className="mb-2 flex items-center gap-2 font-medium">
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Receipt({ ok, text }: { ok: boolean; text: string }): React.ReactElement {
  return (
    <div className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      {ok ? <Check className="size-4 text-foreground" /> : <X className="size-4" />}
      <span>{text}</span>
    </div>
  );
}

export function ApprovalPrompt({ data, onResolved }: { data: ApprovalData; onResolved?: (id: string) => void }): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [chosen, setChosen] = useState<ApprovalDecision | null>(null);

  async function decide(decision: ApprovalDecision): Promise<void> {
    setStatus('submitting');
    setChosen(decision);
    try {
      await respondApproval(data.toolCallId, decision);
      setStatus('resolved');
      onResolved?.(data.toolCallId);
    } catch {
      setStatus('error');
    }
  }

  const label: Record<ApprovalDecision, string> = {
    once: '已允许（本次）',
    session: '已允许（本会话）',
    reject: '已拒绝',
  };

  return (
    <Card icon={<ShieldAlert className="size-4 text-amber-500" />} title="需要审批">
      <div className="space-y-1.5">
        <div className="text-muted-foreground">
          工具 <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{data.toolName}</code>
          {data.grantScope && <> · 范围 <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{data.grantScope}</code></>}
        </div>
        {data.detail && (
          <pre className="overflow-x-auto rounded-lg border bg-background p-2.5 font-mono text-xs leading-relaxed">{data.detail}</pre>
        )}
      </div>

      {status === 'resolved' ? (
        <div className="mt-3">
          <Receipt ok={chosen !== 'reject'} text={chosen ? label[chosen] : ''} />
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={status === 'submitting'} onClick={() => void decide('once')}>
            允许一次
          </Button>
          <Button size="sm" variant="outline" disabled={status === 'submitting'} onClick={() => void decide('session')}>
            本会话允许
          </Button>
          <Button size="sm" variant="destructive" disabled={status === 'submitting'} onClick={() => void decide('reject')}>
            拒绝
          </Button>
          {status === 'error' && <span className="self-center text-xs text-destructive">提交失败，请重试</span>}
        </div>
      )}
    </Card>
  );
}

export function QuestionPrompt({ data, onResolved }: { data: QuestionData; onResolved?: (id: string) => void }): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [picks, setPicks] = useState<string[][]>(() => data.questions.map(() => []));

  function toggle(qi: number, label: string, multi: boolean): void {
    setPicks((prev) => {
      const next = prev.map((a) => [...a]);
      if (multi) {
        const set = new Set(next[qi]);
        set.has(label) ? set.delete(label) : set.add(label);
        next[qi] = [...set];
      } else {
        next[qi] = [label];
      }
      return next;
    });
  }

  async function submit(answers: { selected: string[] }[] | null): Promise<void> {
    setStatus('submitting');
    try {
      await respondQuestion(data.questionId, answers);
      setStatus('resolved');
      if (answers) setPicks(answers.map((a) => a.selected));
      onResolved?.(data.questionId);
    } catch {
      setStatus('error');
    }
  }

  const single = data.questions.length === 1 && !data.questions[0]?.multiSelect;
  const complete = picks.every((p) => p.length > 0);

  if (status === 'resolved') {
    const flat = picks.flat();
    return (
      <Card icon={<CircleHelp className="size-4 text-sky-500" />} title="已回答">
        <Receipt ok={flat.length > 0} text={flat.length ? `已选择：${flat.join('、')}` : '已跳过'} />
      </Card>
    );
  }

  return (
    <Card icon={<CircleHelp className="size-4 text-sky-500" />} title="需要你的选择">
      <div className="space-y-4">
        {data.questions.map((q, qi) => (
          <div key={qi} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{q.header}</span>
              <span className="font-medium">{q.question}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              {q.options.map((o) => {
                const active = picks[qi]?.includes(o.label);
                const onClick = (): void => {
                  if (single) void submit([{ selected: [o.label] }]);
                  else toggle(qi, o.label, q.multiSelect);
                };
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={status === 'submitting'}
                    onClick={onClick}
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-accent disabled:opacity-50',
                      active && 'border-foreground/40 bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-4 shrink-0 items-center justify-center border border-input',
                        q.multiSelect ? 'rounded-[4px]' : 'rounded-full',
                        active && 'border-foreground bg-foreground text-background',
                      )}
                    >
                      {active && <Check className="size-3" />}
                    </span>
                    <span>
                      <span className="block">{o.label}</span>
                      {o.description && <span className="block text-xs text-muted-foreground">{o.description}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {!single && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!complete || status === 'submitting'} onClick={() => void submit(picks.map((selected) => ({ selected })))}>
            提交
          </Button>
          <Button size="sm" variant="ghost" disabled={status === 'submitting'} onClick={() => void submit(null)}>
            跳过
          </Button>
          {status === 'error' && <span className="text-xs text-destructive">提交失败，请重试</span>}
        </div>
      )}
      {single && status === 'error' && <div className="mt-2 text-xs text-destructive">提交失败，请重试</div>}
    </Card>
  );
}

export function PlanPrompt({ data }: { data: PlanData }): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [approved, setApproved] = useState(false);

  async function decide(approve: boolean): Promise<void> {
    setStatus('submitting');
    setApproved(approve);
    try {
      await respondPlan(data.planId, approve);
      setStatus('resolved');
    } catch {
      setStatus('error');
    }
  }

  const actions = (data.allowedActions ?? []).map((a) => (typeof a === 'string' ? a : a.description ?? '')).filter(Boolean);

  return (
    <Card icon={<ClipboardList className="size-4 text-violet-500" />} title="执行计划">
      <div className="md max-w-none rounded-lg border bg-background p-3">
        <Markdown>{data.plan}</Markdown>
      </div>
      {actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {actions.map((a, i) => (
            <span key={i} className="rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              ⚡ {a}
            </span>
          ))}
        </div>
      )}

      {status === 'resolved' ? (
        <div className="mt-3">
          <Receipt ok={approved} text={approved ? '已批准，开始执行' : '已放弃该计划'} />
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={status === 'submitting'} onClick={() => void decide(true)}>
            执行
          </Button>
          <Button size="sm" variant="outline" disabled={status === 'submitting'} onClick={() => void decide(false)}>
            放弃
          </Button>
          {status === 'error' && <span className="self-center text-xs text-destructive">提交失败，请重试</span>}
        </div>
      )}
    </Card>
  );
}
