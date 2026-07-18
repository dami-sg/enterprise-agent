/**
 * Chat view (desktop-app §7, CLI parity): session list, transcript rendered
 * from the shared CLI trace tree, run spinner, todo panel (cli §5), approval /
 * question / plan cards (app-server §5.3) and toast stack.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Circle, CircleDot, FileText, Folder, Loader2, ListTodo, Monitor, PanelLeft, PanelLeftClose, Paperclip, Plus, Sparkles, SquarePen, Square, Trash2, X } from 'lucide-react';
import type { PendingApproval, PendingQuestion, TraceState } from '@dami-sg/cli/trace';
import { fmtTok } from '@dami-sg/cli/trace';
import type { Artifact, Todo } from '@dami-sg/agent-contract';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea, Separator, Skeleton } from '@/components/ui/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Markdown, TraceItems, artifactIcon, fmtBytes } from '@/components/Trace';
import { ArtifactBody, artifactTypes } from '@/components/artifact-view';
import { UPLOAD_MAX, classifyAttachment, pastedImageName, type PendingAttachment } from '@/lib/attachments';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '../../../shared/i18n.js';
import {
  chooseWorkingDir,
  closeArtifactPreview,
  currentTrace,
  deleteSession,
  dismissToast,
  fetchArtifactContent,
  interrupt,
  newChat,
  openArtifact,
  openArtifactPreview,
  openSession,
  refreshProfiles,
  respondApproval,
  respondPlan,
  respondQuestion,
  runComposerInput,
  setExecutionMode,
  toggleSidebar,
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
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);

  const running = !!runId || trace?.status === 'running';

  // Group sessions by working directory (first-seen order preserved); '' = the
  // default scratch workspace.
  const sessionGroups = useMemo(() => {
    const map = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const key = s.workingDir ?? '';
      const arr = map.get(key);
      if (arr) arr.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()];
  }, [sessions]);

  return (
    <div className="flex min-h-0 flex-1">
      {!sidebarCollapsed && (
      <aside className="flex w-56 shrink-0 flex-col gap-0.5 bg-background p-2">
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" className="min-w-0 flex-1 justify-start" onClick={() => newChat()}>
            <SquarePen /> {t('newSession')}
          </Button>
          <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" title={t('hideSidebar')} onClick={toggleSidebar}>
            <PanelLeftClose />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2.5 pr-1">
            {sessionGroups.map(([dir, items]) => (
              <div key={dir || '__default__'} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1 px-2">
                  <Folder className="size-3 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground" title={dir || undefined}>
                    {dir ? baseName(dir) : t('defaultWorkspace')}
                  </span>
                  <button
                    type="button"
                    title={t('newInDir')}
                    onClick={() => newChat(dir || undefined)}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
                {items.map((s) => (
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
            ))}
          </div>
        </ScrollArea>
      </aside>
      )}

      <section className="relative flex min-w-0 flex-1 flex-col">
        {sidebarCollapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-2 z-10 text-muted-foreground [-webkit-app-region:no-drag]"
            title={t('showSidebar')}
            onClick={toggleSidebar}
          >
            <PanelLeft />
          </Button>
        )}
        {restarting && (
          <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <Loader2 className="size-3.5 animate-spin" /> {t('gwRestartingChat')}
          </div>
        )}

        <Transcript trace={trace} running={running} sessionId={currentId} />

        {trace && trace.todos.length > 0 && <TodoPanel todos={trace.todos} />}

        <div className="px-4 pb-2">
          <div className="mx-auto max-w-3xl space-y-2">
            {trace?.pending.map((a) => <ApprovalCard key={a.toolCallId} approval={a} />)}
            {trace?.questions[0] && <QuestionCard key={trace.questions[0].questionId} q={trace.questions[0]} />}
            {plan && <PlanCard planId={plan.planId} plan={plan.plan} />}
          </div>
        </div>

        <Composer running={running} connected={connected} usageLine={trace ? usageLine(trace, t) : undefined} />

        {currentId && trace && <Toasts sessionId={currentId} trace={trace} />}
      </section>

      {currentId && trace && trace.artifacts.length > 0 && <ArtifactsPanel artifacts={trace.artifacts} />}

      <ArtifactPreviewHost />
    </div>
  );
}

/** In-window modal — the LAST-RESORT preview only: non-markdown/html/pdf types
 *  on remote/scratch sessions, or html/pdf whose bytes exceeded the RPC read
 *  cap. Markdown → standalone window; html/pdf → built-in Chromium browser;
 *  local files → browser by path. Driven by store state so the panel and inline
 *  cards open the same one. */
function ArtifactPreviewHost() {
  const sessionId = useStore((s) => s.currentId);
  const artifact = useStore((s) => s.previewArtifact);
  if (!sessionId || !artifact) return null;
  return <ArtifactPreview sessionId={sessionId} artifact={artifact} onClose={closeArtifactPreview} />;
}

function ArtifactPreview({
  sessionId,
  artifact,
  onClose,
}: {
  sessionId: string;
  artifact: Artifact;
  onClose: () => void;
}) {
  const t = useT();
  const [data, setData] = useState<{ base64: string; truncated: boolean } | 'loading' | 'error'>('loading');
  const types = artifactTypes(artifact);
  const wide = types.isPdf || types.isHtml || types.isImage;

  useEffect(() => {
    if (!types.previewable) {
      setData('error');
      return;
    }
    let alive = true;
    void fetchArtifactContent(sessionId, artifact.id).then((r) => {
      if (alive) setData(r ? { base64: r.base64, truncated: r.truncated } : 'error');
    });
    return () => {
      alive = false;
    };
  }, [sessionId, artifact.id, types.previewable]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6">
      <button type="button" aria-label={t('close')} className="absolute inset-0 cursor-default" onClick={onClose} />
      <div
        className={cn(
          'relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-card shadow-xl',
          wide ? 'max-w-4xl' : 'max-w-2xl',
        )}
      >
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          {artifactIcon(artifact.kind, 'size-4 shrink-0 text-primary')}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{artifact.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {artifact.path} · {fmtBytes(artifact.size)}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => openArtifact(sessionId, artifact)}>
            {t('artifactOpen')}
          </Button>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X />
          </Button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {data === 'loading' && <div className="p-4 text-xs text-muted-foreground">{t('loading')}</div>}
          {data === 'error' &&
            (types.previewable ? (
              <div className="p-4 text-xs text-destructive">{t('artifactUnavailable')}</div>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">{t('artifactNoPreview')}</div>
            ))}
          {typeof data === 'object' && (
            <ArtifactBody artifact={artifact} types={types} base64={data.base64} truncated={data.truncated} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Right-side panel listing this session's artifacts (agent §artifacts); a click
 *  previews per type: markdown → standalone window, local files → Chromium
 *  browser, remote → the modal above. */
function ArtifactsPanel({ artifacts }: { artifacts: Artifact[] }) {
  const t = useT();
  return (
    <aside className="flex w-64 shrink-0 flex-col bg-background">
      <div className="px-3 py-2.5 text-xs font-medium text-muted-foreground">
        {t('artifacts', { count: artifacts.length })}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {artifacts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => openArtifactPreview(a)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
            >
              {artifactIcon(a.kind, 'size-4 shrink-0 text-muted-foreground')}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{a.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {a.kind} · {fmtBytes(a.size)}
                </div>
              </div>
            </button>
          ))}
        </div>
      </ScrollArea>
    </aside>
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
    <Card className="rounded-2xl border-0 bg-warning/10">
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
    <Card className="rounded-2xl border-0 bg-muted/60">
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
    <Card className="rounded-2xl border-0 bg-success/10">
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
function baseName(p: string): string {
  return p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
}

/** Row above the input (profile + working-dir pills). The profile is always
 *  switchable (moved here from the header); the working-dir folder is pickable
 *  only in a draft new chat — an existing session shows its dir read-only, since
 *  a session's working directory is fixed at creation. */
function WorkContextBar() {
  const t = useT();
  const profiles = useStore((s) => s.profiles);
  const activeId = useStore((s) => s.activeProfileId);
  const currentId = useStore((s) => s.currentId);
  const draftWorkingDir = useStore((s) => s.draftWorkingDir);
  // Remote profiles get NO dir control: the server pins every session to the
  // account's fixed workspace (`<data root>/workspaces/<accountId>`), so there
  // is nothing to choose client-side.
  const remote = profiles.find((p) => p.id === activeId)?.mode === 'remote';
  // Only shown while composing a NEW chat (draft). Once a conversation has
  // started (a session exists) both the profile and working dir are fixed for
  // that session, so the row is hidden and the input area stays clean.
  if (currentId) return null;
  return (
    <div className="mx-auto mb-1.5 flex max-w-3xl items-center gap-2 px-1">
      <Select
        value={activeId ?? ''}
        onValueChange={(id) => {
          // A working dir belongs to one machine — reset the whole draft
          // context when the profile changes.
          newChat();
          void window.ea.profiles.setActive(id).then(refreshProfiles);
        }}
      >
        <SelectTrigger className="h-7 w-auto gap-1.5 rounded-full border-0 bg-muted/60 px-3 text-xs hover:bg-muted">
          <Monitor className="size-3.5 shrink-0" />
          <SelectValue placeholder={t('selectProfile')} />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!remote && (
        <button
          type="button"
          onClick={() => void chooseWorkingDir()}
          title={draftWorkingDir ?? t('chooseDir')}
          className="flex h-7 items-center gap-1.5 rounded-full bg-muted/60 px-3 text-xs hover:bg-muted"
        >
          <Folder className="size-3.5 shrink-0" />
          <span className="max-w-40 truncate">{draftWorkingDir ? baseName(draftWorkingDir) : t('chooseDir')}</span>
        </button>
      )}
    </div>
  );
}

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
  const mode = useStore((s) => (s.currentId ? s.modes[s.currentId] : s.draftMode) ?? 'ask');
  const sending = useStore((s) => s.sending);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /** Transient client-side validation error (too large / folder) — shown in the
   *  chips row because a draft chat has no session to toast into. */
  const [attachError, setAttachError] = useState<string>();
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteCounter = useRef(0);
  const errTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flashError = (text: string): void => {
    setAttachError(text);
    clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setAttachError(undefined), 4000);
  };

  const addFiles = (files: Iterable<File>): void => {
    const next: PendingAttachment[] = [];
    for (const f of files) {
      if (f.size > UPLOAD_MAX) {
        flashError(t('attachmentTooLarge', { name: f.name }));
        continue;
      }
      const name = f.name || pastedImageName(f.type, ++pasteCounter.current);
      const kind = classifyAttachment(name, f.type);
      next.push({
        id: crypto.randomUUID(),
        file: f,
        name,
        size: f.size,
        mime: f.type,
        kind,
        previewUrl: kind === 'image' ? URL.createObjectURL(f) : undefined,
      });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  };

  const removeAttachment = (id: string): void => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  };

  const submit = (): void => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || running || sending || !connected) return;
    // Clear only on success — a failed upload keeps draft + chips for retry.
    void runComposerInput(text, attachments).then((outcome) => {
      if (outcome === 'failed') return;
      setDraft('');
      if (outcome === 'sent') {
        for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        setAttachments([]);
      }
    });
  };
  return (
    <footer className="px-4 pb-4 pt-1">
      <WorkContextBar />
      {/* Ollama-style input pill: one borderless rounded surface holding the
          textarea plus an inline control row (attach · mode · usage · send). */}
      <div
        className={cn(
          'mx-auto max-w-3xl rounded-3xl bg-muted/60 px-4 pb-2.5 pt-3 transition-colors focus-within:bg-muted',
          dragOver && 'ring-2 ring-primary/50',
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!connected) return;
          const files: File[] = [];
          let folder = false;
          for (const item of e.dataTransfer.items) {
            // webkitGetAsEntry is the only way to detect directory drops.
            const entry = (item as { webkitGetAsEntry?: () => { isDirectory?: boolean } | null }).webkitGetAsEntry?.();
            if (entry?.isDirectory) {
              folder = true;
              continue;
            }
            const f = item.getAsFile();
            if (f) files.push(f);
          }
          if (folder) flashError(t('folderNotSupported'));
          addFiles(files);
        }}
      >
        {(attachments.length > 0 || attachError) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-1.5 rounded-lg bg-background/70 px-2 py-1 text-xs">
                {a.previewUrl ? (
                  <img src={a.previewUrl} alt={a.name} className="size-10 rounded object-cover" />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-40 truncate">{a.name}</span>
                <span className="text-muted-foreground">{fmtBytes(a.size)}</span>
                <button
                  type="button"
                  title={t('removeAttachment')}
                  className="cursor-pointer opacity-60 hover:opacity-100"
                  onClick={() => removeAttachment(a.id)}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {attachError && <span className="text-[11px] text-destructive">{attachError}</span>}
          </div>
        )}
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
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              addFiles(files);
              e.preventDefault();
            }
          }}
          className="min-h-10 max-h-48 resize-none overflow-y-auto border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0 focus-visible:outline-none"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept=".txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/*,text/*,.js,.ts,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.sh,.sql,.html,.css"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            className="rounded-full"
            disabled={!connected || sending}
            title={t('attachFiles')}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
          </Button>
          <Select
            value={mode}
            disabled={!connected}
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
            <Button
              size="icon"
              className="rounded-full"
              onClick={submit}
              disabled={!connected || sending || (!draft.trim() && attachments.length === 0)}
              title={t('send')}
            >
              {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
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
