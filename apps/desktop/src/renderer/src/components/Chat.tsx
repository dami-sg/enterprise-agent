/**
 * Chat view (desktop-app §7, CLI parity): session list, transcript rendered
 * from the shared CLI trace tree, run spinner, todo panel (cli §5), approval /
 * question / plan cards (app-server §5.3) and toast stack.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Circle, CircleDot, Loader2, ListTodo, Sparkles, SquarePen, Square, Trash2, X } from 'lucide-react';
import type { PendingApproval, PendingQuestion, TraceState } from '@dami-sg/cli/trace';
import { fmtTok } from '@dami-sg/cli/trace';
import type { Todo } from '@dami-sg/agent-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea, Separator, Skeleton } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Markdown, TraceItems } from '@/components/Trace';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '../../../shared/i18n.js';
import {
  createSession,
  currentTrace,
  deleteSession,
  dismissToast,
  interrupt,
  openSession,
  respondApproval,
  respondPlan,
  respondQuestion,
  runComposerInput,
  setExecutionMode,
  useStore,
} from '@/store';
import { cn, previewJson } from '@/lib/utils';

export function Chat() {
  const t = useT();
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentId);
  const trace = useStore(currentTrace);
  const plan = useStore((s) => (s.currentId ? s.plans[s.currentId] : undefined));
  const runId = useStore((s) => (s.currentId ? s.runIds[s.currentId] : undefined));
  const connected = useStore((s) => s.rpc.phase === 'connected');
  const restarting = useStore((s) => s.rpc.phase === 'gateway-restarting');

  const running = !!runId || trace?.status === 'running';

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 shrink-0 flex-col gap-0.5 bg-background p-2">
        <Button variant="ghost" className="justify-start" disabled={!connected} onClick={() => void createSession()}>
          <SquarePen /> {t('newSession')}
        </Button>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 pr-1">
            {sessions.map((s) => (
              <div key={s.id} className="group flex items-center gap-0.5">
                <Button
                  variant={currentId === s.id ? 'secondary' : 'ghost'}
                  className="min-w-0 flex-1 justify-start"
                  onClick={() => void openSession(s.id)}
                >
                  <span className="truncate">{s.name || s.id}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                  title={t('deleteSession')}
                  onClick={() => {
                    if (window.confirm(t('deleteSessionConfirm', { name: s.name || s.id }))) {
                      void deleteSession(s.id);
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        {restarting && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <Loader2 className="size-3.5 animate-spin" /> {t('gwRestartingChat')}
          </div>
        )}

        <Transcript trace={trace} running={running} sessionId={currentId} />

        {trace && trace.todos.length > 0 && <TodoPanel todos={trace.todos} />}

        <div className="space-y-2 px-4 pb-2">
          {trace?.pending.map((a) => <ApprovalCard key={a.toolCallId} approval={a} />)}
          {trace?.questions[0] && <QuestionCard key={trace.questions[0].questionId} q={trace.questions[0]} />}
          {plan && <PlanCard planId={plan.planId} plan={plan.plan} />}
        </div>

        <Composer running={running} connected={connected} usageLine={trace ? usageLine(trace, t) : undefined} />

        {currentId && trace && <Toasts sessionId={currentId} trace={trace} />}
      </section>
    </div>
  );
}

function usageLine(
  trace: TraceState,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): { text: string; title: string } | undefined {
  if (!trace.usage.totalTokens) return undefined;
  const total = fmtTok(trace.usage.totalTokens);
  // Two DIFFERENT metrics live in this line, which reads as contradictory
  // ("149k but window 6%?"): `totalTokens` is the session-cumulative odometer
  // (every request + auxiliary/sub-agent call, output included), while the
  // window % is only the last orchestrator request's input over the context
  // window. The tooltip spells that out so the two numbers stop looking wrong.
  const hasWin = Boolean(trace.contextWindow && trace.lastInputTokens);
  const pct = hasWin ? Math.round((trace.lastInputTokens! / trace.contextWindow!) * 100) : 0;
  const win = hasWin ? t('usageWindow', { pct }) : '';
  const text = `${total} · $${trace.usage.cost.toFixed(4)}${win}`;
  const title = hasWin
    ? t('usageTip', {
        total,
        input: fmtTok(trace.lastInputTokens!),
        window: fmtTok(trace.contextWindow!),
        pct,
      })
    : t('usageTipNoWin', { total });
  return { text, title };
}

function Transcript({
  trace,
  running,
  sessionId,
}: {
  trace?: TraceState;
  running: boolean;
  sessionId?: string;
}) {
  const t = useT();
  const lastTurnUsage = useStore((s) => (sessionId ? s.lastTurnUsage[sessionId] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const root = trace?.rootAgentId ? trace.agents.get(trace.rootAgentId) : undefined;
    return root?.children ?? [];
  }, [trace]);

  // Follow the stream: stick to the bottom while new content lands. `trace` is
  // a fresh object per dispatch, so it IS the "new content arrived" signal even
  // though the effect body only touches the DOM.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trace is the scroll trigger
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [trace, lastTurnUsage]);

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {items.length === 0 && !running && (
          <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground">
            <Sparkles className="size-9 opacity-30" />
            <span className="text-sm">{t('emptyChat')}</span>
          </div>
        )}
        <TraceItems items={items} />
        {running && <ThinkingRow streaming={lastIsStreamingText(trace)} />}
        {trace?.status === 'error' && trace.lastError && (
          <Alert variant="destructive">
            <X />
            <AlertDescription>{trace.lastError}</AlertDescription>
          </Alert>
        )}
        {!running && lastTurnUsage && lastTurnUsage.totalTokens > 0 && (
          <div className="text-right text-[11px] text-muted-foreground tabular-nums">
            {t('turnUsage', {
              tok: fmtTok(lastTurnUsage.totalTokens),
              cost: lastTurnUsage.cost.toFixed(4),
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function lastIsStreamingText(trace?: TraceState): boolean {
  const root = trace?.rootAgentId ? trace.agents.get(trace.rootAgentId) : undefined;
  const last = root?.children[root.children.length - 1];
  return !!last && last.kind === 'text' && last.speaker !== 'user';
}

/** Loading affordance (cli §2): a spinner row while the turn runs; before the
 *  first delta it doubles as the "thinking" placeholder with a skeleton. */
function ThinkingRow({ streaming }: { streaming: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-primary" />
      {streaming ? t('generating') : t('thinking')}
      {!streaming && <Skeleton className="h-3 w-40" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Todo panel (cli §5): floats over the transcript, mirrors TaskList state.
// ---------------------------------------------------------------------------
function todoIcon(status: Todo['status']) {
  switch (status) {
    case 'completed':
      return <Check className="size-3.5 text-success" />;
    case 'in_progress':
      return <CircleDot className="size-3.5 animate-pulse text-primary" />;
    default:
      return <Circle className="size-3.5 text-muted-foreground" />;
  }
}

function TodoPanel({ todos }: { todos: Todo[] }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="absolute right-3 top-3 z-10 w-64">
      <Card className="bg-card/95 shadow-lg backdrop-blur">
        <CardHeader className="cursor-pointer select-none p-2.5 pb-1" onClick={() => setCollapsed((c) => !c)}>
          <CardTitle className="flex items-center gap-2 text-xs">
            <ListTodo className="size-3.5 text-primary" />
            {t('todos', { done, total: todos.length })}
            <span className="ml-auto text-[10px] text-muted-foreground">{collapsed ? t('expand') : t('collapse')}</span>
          </CardTitle>
        </CardHeader>
        {!collapsed && (
          <CardContent className="max-h-56 space-y-1 overflow-y-auto p-2.5 pt-1">
            {todos.map((todo) => (
              <div key={todo.id} className="flex items-start gap-2 text-xs leading-snug">
                <span className="mt-0.5 shrink-0">{todoIcon(todo.status)}</span>
                <span className={cn(todo.status === 'completed' && 'text-muted-foreground line-through')}>{todo.content}</span>
              </div>
            ))}
          </CardContent>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive cards (app-server §5.3)
// ---------------------------------------------------------------------------
function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const t = useT();
  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs">
          <Badge variant="warning">{t('approval')}</Badge>
          <span className="font-mono">{approval.toolName}</span>
          {approval.grantScope && <span className="font-mono text-muted-foreground">{approval.grantScope}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {approval.input != null && (
          <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">
            {previewJson(approval.input, 1500)}
          </pre>
        )}
        <div className="flex gap-2">
          <Button onClick={() => void respondApproval(approval.toolCallId, 'once')}>{t('allowOnce')}</Button>
          <Button variant="secondary" onClick={() => void respondApproval(approval.toolCallId, 'session')}>
            {t('allowSession')}
          </Button>
          <Button variant="destructive" onClick={() => void respondApproval(approval.toolCallId, 'reject')}>
            {t('reject')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function QuestionCard({ q }: { q: PendingQuestion }) {
  const t = useT();
  const [selected, setSelected] = useState<string[][]>(q.questions.map(() => []));
  const toggle = (qi: number, label: string, multi: boolean): void => {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      const cur = next[qi]!;
      next[qi] = multi ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return next;
    });
  };
  const canSubmit = selected.every((s) => s.length > 0);
  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-3 pt-3">
        {q.questions.map((question, qi) => (
          <div key={question.question} className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Badge variant="secondary">{question.header}</Badge>
              {question.question}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((opt) => (
                <Button
                  key={opt.label}
                  size="sm"
                  variant={selected[qi]!.includes(opt.label) ? 'default' : 'outline'}
                  title={opt.description}
                  onClick={() => toggle(qi, opt.label, question.multiSelect)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <Button
          disabled={!canSubmit}
          onClick={() =>
            void respondQuestion(
              q.questionId,
              selected.map((s) => ({ selected: s })),
            )
          }
        >
          {t('submit')}
        </Button>
      </CardContent>
    </Card>
  );
}

function PlanCard({ planId, plan }: { planId: string; plan: string }) {
  const t = useT();
  return (
    <Card className="border-success/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs">
          <Badge variant="success">{t('planConfirm')}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <ScrollArea className="max-h-64 rounded bg-background/60 p-2.5">
          <Markdown text={plan} />
        </ScrollArea>
        <div className="flex gap-2">
          <Button onClick={() => void respondPlan(planId, 'approve')}>{t('approvePlan')}</Button>
          <Button variant="destructive" onClick={() => void respondPlan(planId, 'reject')}>
            {t('reject')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Composer + toasts
// ---------------------------------------------------------------------------
function Composer({
  running,
  connected,
  usageLine,
}: {
  running: boolean;
  connected: boolean;
  usageLine?: { text: string; title: string };
}) {
  const t = useT();
  const currentId = useStore((s) => s.currentId);
  const mode = useStore((s) => (s.currentId ? s.modes[s.currentId] : undefined) ?? 'ask');
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    const text = draft.trim();
    if (!text || running || !connected) return;
    setDraft('');
    void runComposerInput(text);
  };
  return (
    <footer className="px-4 pb-4 pt-1">
      {/* Ollama-style input pill: one borderless rounded surface holding the
          textarea plus an inline control row (mode · usage · circular send). */}
      <div className="mx-auto max-w-3xl rounded-3xl bg-muted/60 px-4 pb-2.5 pt-3 transition-colors focus-within:bg-muted">
        <Textarea
          placeholder={connected ? t('composerPh') : t('composerDisconnected')}
          value={draft}
          disabled={!connected}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // `isComposing` guards against IME candidate selection (e.g. Chinese
            // pinyin): Enter to pick a candidate must not submit the message.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="min-h-10 max-h-48 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0 focus-visible:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <Select
            value={mode}
            disabled={!connected || !currentId}
            onValueChange={(v) => void setExecutionMode(v as 'ask' | 'plan' | 'auto' | 'full')}
          >
            <SelectTrigger className="h-7 w-auto gap-1 rounded-full border-0 bg-transparent px-2.5 text-xs hover:bg-accent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t('modeAsk')}</SelectItem>
              <SelectItem value="plan">{t('modePlan')}</SelectItem>
              <SelectItem value="auto">{t('modeAuto')}</SelectItem>
              <SelectItem value="full">{t('modeFull')}</SelectItem>
            </SelectContent>
          </Select>
          {usageLine && (
            <div className="cursor-help text-[11px] text-muted-foreground tabular-nums" title={usageLine.title}>
              {usageLine.text}
            </div>
          )}
          <div className="flex-1" />
          {running ? (
            <Button variant="destructive" size="icon" className="rounded-full" onClick={() => void interrupt()} title={t('interrupt')}>
              <Square className="size-3" />
            </Button>
          ) : (
            <Button size="icon" className="rounded-full" onClick={submit} disabled={!connected || !draft.trim()} title={t('send')}>
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}

function Toasts({ sessionId, trace }: { sessionId: string; trace: TraceState }) {
  // Safety net: hide any residual "run 完成" consumption toasts (also dismissed
  // in handleNotification). Other toasts (errors, approvals, …) still show.
  const toasts = trace.toasts.filter((toast) => !toast.text.startsWith('run 完成'));

  // Auto-dismiss non-persistent toasts (cli §2.3). Depend on the source array
  // identity from the reducer, not the filtered `toasts` copy.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter is derived from trace.toasts
  useEffect(() => {
    const timers = toasts
      .filter((toast) => !toast.persistent)
      .map((toast) => setTimeout(() => dismissToast(sessionId, toast.id), 4000));
    return () => timers.forEach(clearTimeout);
  }, [sessionId, trace.toasts]);

  if (!toasts.length) return null;
  return (
    <div className="absolute bottom-28 right-3 z-20 flex w-72 flex-col gap-1.5">
      {toasts.map((toast) => (
        <Alert
          key={toast.id}
          variant={toast.level === 'danger' ? 'destructive' : toast.level === 'warning' ? 'warning' : 'success'}
          className="shadow-lg"
        >
          <AlertDescription className="flex-1">{toast.text}</AlertDescription>
          <button
            type="button"
            className="cursor-pointer opacity-60 hover:opacity-100"
            onClick={() => dismissToast(sessionId, toast.id)}
          >
            <X className="size-3.5" />
          </button>
        </Alert>
      ))}
    </div>
  );
}
