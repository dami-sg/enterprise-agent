/**
 * Renderer state (desktop-app §7): zustand around the CLI's render-agnostic
 * trace reducer (`@dami-sg/cli/trace`, cli §5.3) — the SAME fold the TUI uses,
 * so tool calls, approvals, questions, sub-agent nesting/re-homing, todos,
 * usage and history reconstruction behave identically to the CLI.
 *
 * App-server notifications are the projection `{ sessionId, ...event }`
 * (agent-server projectEvent): most carry the original `kind` and cast back to
 * an AgentStreamEvent directly; deltas / turn-completed / session-updated are
 * re-shaped here.
 */
import { create } from 'zustand';
import {
  initialTrace,
  reduceTrace,
  reconstructTrace,
  type TraceAction,
  type TraceState,
} from '@dami-sg/cli/trace';
import type { AgentStreamEvent, ExecutionMode, SessionTree, Todo, UsageTotals } from '@dami-sg/agent-contract';
import { EXECUTION_MODE } from '@dami-sg/agent-contract';
import type {
  AppSettings,
  ConnectionProfile,
  GatewaySnapshot,
  RpcState,
  UpdateState,
} from '../../shared/ipc.js';
import { I18N, resolveLang, t, type MessageKey } from '../../shared/i18n.js';

export interface SessionMeta {
  id: string;
  name?: string;
}

export interface PendingPlan {
  planId: string;
  plan: string;
}

interface DesktopState {
  profiles: ConnectionProfile[];
  activeProfileId?: string;
  gw?: GatewaySnapshot;
  rpc: RpcState;
  settings: AppSettings;
  update: UpdateState;
  appInfo?: { appVersion: string; electron: string; bundledGateway?: string; platform: string };

  sessions: SessionMeta[];
  currentId?: string;
  traces: Record<string, TraceState>;
  plans: Record<string, PendingPlan | undefined>;
  /** In-flight turn per session (mid-run send guard, cli §6.2). */
  runIds: Record<string, string | undefined>;
  /** Live execution mode per session (agent §3.8) — ask / plan / auto / full. */
  modes: Record<string, ExecutionMode | undefined>;
  /** Session-cumulative usage snapshot taken at the start of the current turn. */
  turnUsageBaseline: Record<string, UsageTotals | undefined>;
  /** Latest completed turn's consumption (desktop shows this in-transcript, not as toast). */
  lastTurnUsage: Record<string, UsageTotals | undefined>;
}

export const useStore = create<DesktopState>(() => ({
  profiles: [],
  rpc: { phase: 'idle' },
  settings: { stopGatewayOnQuit: false, theme: 'system', language: 'system' },
  update: { phase: 'idle' },
  sessions: [],
  traces: {},
  plans: {},
  runIds: {},
  modes: {},
  turnUsageBaseline: {},
  lastTurnUsage: {},
}));

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  cost: 0,
};

function usageDelta(current: UsageTotals, baseline: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - baseline.reasoningTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - baseline.cachedInputTokens),
    cost: Math.max(0, current.cost - baseline.cost),
  };
}

const set = useStore.setState;
const get = useStore.getState;

export function activeProfile(): ConnectionProfile | undefined {
  const s = get();
  return s.profiles.find((p) => p.id === s.activeProfileId);
}

export function currentTrace(state: DesktopState): TraceState | undefined {
  return state.currentId ? state.traces[state.currentId] : undefined;
}

// ---------------------------------------------------------------------------
// Trace dispatch
// ---------------------------------------------------------------------------
export function dispatch(sessionId: string, action: TraceAction): void {
  set((s) => ({
    traces: { ...s.traces, [sessionId]: reduceTrace(s.traces[sessionId] ?? initialTrace(), action) },
  }));
}

/** Map an app-server notification back to the stream event the reducer folds. */
function toEvent(method: string, p: Record<string, unknown>): AgentStreamEvent | undefined {
  switch (method) {
    case 'item/textDelta':
      return { kind: 'text-delta', runId: String(p.runId), agentId: String(p.agentId ?? 'orch'), text: String(p.text ?? '') };
    case 'item/reasoningDelta':
      return { kind: 'reasoning-delta', runId: String(p.runId), agentId: String(p.agentId ?? 'orch'), text: String(p.text ?? '') };
    case 'turn/completed':
      return { kind: 'run-finish', runId: String(p.runId), finishReason: String(p.finishReason ?? 'stop') } as AgentStreamEvent;
    default:
      // Projections spread the original event, so `kind` rides along for
      // toolCall/toolResult/approvalRequired/questionRequired/subAgent*/usage/….
      return typeof p.kind === 'string' ? (p as unknown as AgentStreamEvent) : undefined;
  }
}

export function handleNotification(n: { method: string; params?: unknown }): void {
  const p = (n.params ?? {}) as Record<string, unknown>;
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined;
  if (!sessionId) return;

  switch (n.method) {
    case 'turn/started':
      set((s) => ({ runIds: { ...s.runIds, [sessionId]: String(p.runId ?? '') || undefined } }));
      return;
    case 'turn/completed': {
      const runId = String(p.runId ?? '');
      // Only the top-level turn we started clears the spinner / triggers auto-title
      // (nested sub-agent run-finish also projects as turn/completed).
      if (get().runIds[sessionId] === runId) {
        set((s) => {
          const baseline = s.turnUsageBaseline[sessionId] ?? EMPTY_USAGE;
          const usage = s.traces[sessionId]?.usage ?? EMPTY_USAGE;
          return {
            runIds: { ...s.runIds, [sessionId]: undefined },
            lastTurnUsage: { ...s.lastTurnUsage, [sessionId]: usageDelta(usage, baseline) },
          };
        });
        void maybeTitle(sessionId);
      }
      break; // also fold run-finish into the trace below
    }
    case 'item/planProposed': {
      // Plan confirmation is a pending card, not a trace item (app-server §5.3).
      set((s) => ({
        plans: { ...s.plans, [sessionId]: { planId: String(p.planId), plan: String(p.plan ?? '') } },
      }));
      return;
    }
    case 'session/updated': {
      if (Array.isArray(p.todos)) {
        dispatch(sessionId, { kind: 'todo-update', sessionId, todos: p.todos as Todo[] });
      }
      if (typeof p.mode === 'string') {
        set((s) => ({ modes: { ...s.modes, [sessionId]: p.mode as ExecutionMode } }));
      }
      return;
    }
    default:
      break;
  }

  const event = toEvent(n.method, p);
  if (event) dispatch(sessionId, event);

  // Desktop shows latest-turn consumption in the transcript; drop the shared
  // reducer's "run 完成 · … tok" toast so it never flashes as a popup.
  if (n.method === 'turn/completed') {
    for (const toast of get().traces[sessionId]?.toasts ?? []) {
      if (toast.text.startsWith('run 完成')) dismissToast(sessionId, toast.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Session actions (over the preload rpc bridge)
// ---------------------------------------------------------------------------
export async function loadSessions(): Promise<void> {
  const res = (await window.ea.rpc.request('session/list', {})) as { sessions: Array<Record<string, unknown>> };
  const metas = res.sessions.map((s) => ({
    id: String(s.id),
    name: typeof s.name === 'string' ? s.name : undefined,
  }));
  set({ sessions: metas });
  if (!get().currentId && metas[0]) await openSession(metas[0].id);
}

export async function openSession(sessionId: string): Promise<void> {
  set({ currentId: sessionId });
  await window.ea.rpc.request('event/subscribe', { kind: 'session', sessionId }).catch(() => {});
  // History is the authority (app-server §8.1): rebuild the CLI-identical trace
  // from the persisted tree (root→head path), then restore todos, live mode, and
  // the usage / window-occupancy readout (cli-ui §2.1 — reconstructTrace zeroes usage).
  const res = (await window.ea.rpc.request('session/history', { sessionId }).catch(() => undefined)) as
    | { tree?: SessionTree }
    | undefined;
  const stale = () => get().currentId !== sessionId; // user switched mid-load
  if (stale()) return;
  set((s) => ({
    traces: {
      ...s.traces,
      [sessionId]: res?.tree ? reconstructTrace(res.tree) : (s.traces[sessionId] ?? initialTrace()),
    },
  }));
  const [todos, modeRes, list] = await Promise.all([
    window.ea.rpc.request('session/todos', { sessionId }).catch(() => undefined) as Promise<{ todos?: Todo[] } | undefined>,
    window.ea.rpc.request('mode/get', { sessionId }).catch(() => undefined) as Promise<{ mode?: ExecutionMode } | undefined>,
    window.ea.rpc.request('session/list', {}).catch(() => undefined) as Promise<
      | { sessions: Array<Record<string, unknown>> }
      | undefined
    >,
  ]);
  if (stale()) return;
  if (todos?.todos) dispatch(sessionId, { kind: 'todo-update', sessionId, todos: todos.todos });
  set((s) => ({
    modes: { ...s.modes, [sessionId]: modeRes?.mode ?? s.modes[sessionId] ?? EXECUTION_MODE.ASK },
  }));
  const session = list?.sessions.find((s) => String(s.id) === sessionId);
  if (session?.usage && typeof session.usage === 'object') {
    dispatch(sessionId, {
      kind: '@set-usage',
      usage: session.usage as UsageTotals,
      lastInputTokens: typeof session.lastInputTokens === 'number' ? session.lastInputTokens : undefined,
      contextWindow: typeof session.contextWindow === 'number' ? session.contextWindow : undefined,
    });
  }
}

export async function deleteSession(sessionId: string): Promise<void> {
  await window.ea.rpc.request('session/delete', { sessionId });
  set((s) => {
    const traces = { ...s.traces };
    const plans = { ...s.plans };
    const runIds = { ...s.runIds };
    const modes = { ...s.modes };
    const turnUsageBaseline = { ...s.turnUsageBaseline };
    const lastTurnUsage = { ...s.lastTurnUsage };
    delete traces[sessionId];
    delete plans[sessionId];
    delete runIds[sessionId];
    delete modes[sessionId];
    delete turnUsageBaseline[sessionId];
    delete lastTurnUsage[sessionId];
    return {
      sessions: s.sessions.filter((m) => m.id !== sessionId),
      traces,
      plans,
      runIds,
      modes,
      turnUsageBaseline,
      lastTurnUsage,
      currentId: s.currentId === sessionId ? undefined : s.currentId,
    };
  });
  // Deleted the open session → fall over to the first remaining one.
  const next = get();
  if (!next.currentId && next.sessions[0]) await openSession(next.sessions[0].id);
}

function msg(key: MessageKey, vars?: Record<string, string | number>): string {
  const lang = resolveLang(get().settings.language, navigator.language);
  return t(lang, key, vars);
}

/** Default placeholder titles — either language, plus the CLI's historical name. */
const UNTITLED = new Set<string>([I18N.zh.untitledSession, I18N.en.untitledSession, '新会话']);

/** In-flight auto-title calls (cli-ui §1.1) — dedupe concurrent turn/completed. */
const titling = new Set<string>();

/** Short preview of the first user message — fallback when title-gen is empty. */
function firstUserSummary(sessionId: string): string {
  const trace = get().traces[sessionId];
  const root = trace?.rootAgentId ? trace.agents.get(trace.rootAgentId) : undefined;
  const user = root?.children.find((c) => c.kind === 'text' && c.speaker === 'user');
  if (!user || user.kind !== 'text') return '';
  const text = user.text.trim().replace(/\s+/g, ' ');
  const cp = [...text];
  return cp.length > 24 ? `${cp.slice(0, 24).join('')}…` : cp.join('');
}

/**
 * Auto-title a session after its first turn (cli-ui §1.1). Gate is "name is still
 * the default placeholder" — already-named sessions are left alone. Failed attempts
 * can retry on a later turn/completed.
 */
async function maybeTitle(sessionId: string): Promise<void> {
  if (titling.has(sessionId)) return;
  titling.add(sessionId);
  try {
    const meta = get().sessions.find((s) => s.id === sessionId);
    if (!meta?.name || !UNTITLED.has(meta.name)) return;
    const res = (await window.ea.rpc
      .request('session/generateTitle', { sessionId })
      .catch(() => ({ title: '' }))) as { title?: string };
    const title = (res.title ?? '').trim() || firstUserSummary(sessionId);
    if (!title) return;
    await window.ea.rpc.request('session/rename', { sessionId, name: title });
    set((s) => ({
      sessions: s.sessions.map((m) => (m.id === sessionId ? { ...m, name: title } : m)),
    }));
  } catch {
    // keep the placeholder; a later turn may retry
  } finally {
    titling.delete(sessionId);
  }
}

export async function createSession(name?: string): Promise<void> {
  const fallback = msg('untitledSession');
  const res = (await window.ea.rpc.request('session/create', { name: name?.trim() || fallback })) as {
    session: { id: string };
  };
  await loadSessions();
  await openSession(res.session.id);
}

export async function sendMessage(text: string): Promise<void> {
  const sessionId = get().currentId;
  if (!sessionId || !text.trim()) return;
  // Mid-run send guard (cli §6.2): a second in-flight turn would strand the
  // running turn's approval/question events.
  if (get().runIds[sessionId]) {
    dispatch(sessionId, { kind: '@toast', level: 'warning', text: msg('turnInProgress') });
    return;
  }
  // Snapshot session-cumulative usage so we can report this turn's delta after
  // run-finish (shown in-transcript; the shared reducer's "run 完成" toast is
  // filtered out on desktop).
  const usage = get().traces[sessionId]?.usage;
  set((s) => ({
    turnUsageBaseline: {
      ...s.turnUsageBaseline,
      [sessionId]: usage ? { ...usage } : { ...EMPTY_USAGE },
    },
    lastTurnUsage: { ...s.lastTurnUsage, [sessionId]: undefined },
  }));
  dispatch(sessionId, { kind: '@user-text', text });
  try {
    const res = (await window.ea.rpc.request('turn/start', {
      sessionId,
      input: [{ type: 'text', text }],
    })) as { runId: string };
    set((s) => ({ runIds: { ...s.runIds, [sessionId]: res.runId } }));
  } catch (err) {
    dispatch(sessionId, {
      kind: '@toast',
      level: 'danger',
      text: msg('sendFailed', { error: (err as Error).message }),
    });
  }
}

export async function interrupt(): Promise<void> {
  const sessionId = get().currentId;
  const runId = sessionId ? get().runIds[sessionId] : undefined;
  if (!runId) return;
  await window.ea.rpc.request('turn/interrupt', { runId }).catch(() => {});
}

// -- built-in slash commands (composer) ----------------------------------
// A composer submission of the form `/<name>` runs a built-in command instead of
// sending a chat message; `/<name> <args>` passes the trailing text as the
// command argument (e.g. a future `/plan 写测试文档`). An UNMATCHED slash — a
// typo, or legitimate text/path like `/etc/hosts` — falls through to a normal
// message so nothing real is swallowed.
interface SlashCommand {
  name: string;
  /** Run with the open session id and the trimmed argument string (may be ''). */
  run(sessionId: string, arg: string): Promise<void>;
}

const SLASH_COMMANDS: SlashCommand[] = [
  // `/compact` — manually compact the current context (no argument).
  { name: 'compact', run: (sessionId) => compactSession(sessionId) },
];

/** Dispatch a composer submission: a matching `/command` runs the built-in;
 *  anything else is sent as a normal message. Call this from the composer
 *  instead of `sendMessage` directly. */
export async function runComposerInput(text: string): Promise<void> {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const cmd = match && SLASH_COMMANDS.find((c) => c.name === match[1]?.toLowerCase());
  if (match && cmd) {
    const sessionId = get().currentId;
    if (sessionId) await cmd.run(sessionId, (match[2] ?? '').trim());
    return;
  }
  await sendMessage(text);
}

/** Manually compact the open session's context (agent §5.5, the `/compact`
 *  command). `session/compact` runs synchronously server-side, but its
 *  compaction events carry `runId:'manual'` which the app-server can't map to a
 *  session subscription — so they never reach us. We therefore rebuild the
 *  transcript from history (which now holds the summary entry) once the RPC
 *  resolves, and toast a confirmation. */
export async function compactSession(sessionId: string): Promise<void> {
  if (get().runIds[sessionId]) {
    dispatch(sessionId, { kind: '@toast', level: 'warning', text: msg('turnInProgress') });
    return;
  }
  try {
    await window.ea.rpc.request('session/compact', { sessionId });
    if (get().currentId !== sessionId) return; // user switched sessions meanwhile
    await openSession(sessionId); // history-authoritative reload surfaces the summary marker
    dispatch(sessionId, { kind: '@toast', level: 'success', text: msg('compactDone') });
  } catch (err) {
    dispatch(sessionId, {
      kind: '@toast',
      level: 'danger',
      text: msg('sendFailed', { error: (err as Error).message }),
    });
  }
}

export async function respondApproval(toolCallId: string, decision: 'once' | 'session' | 'reject'): Promise<void> {
  const sessionId = get().currentId;
  await window.ea.rpc.request('approval/respond', { toolCallId, decision });
  if (sessionId) dispatch(sessionId, { kind: '@approval-decision', toolCallId, decision });
}

export async function respondQuestion(questionId: string, answers: Array<{ selected: string[] }>): Promise<void> {
  const sessionId = get().currentId;
  await window.ea.rpc.request('question/respond', { questionId, answers });
  if (sessionId) dispatch(sessionId, { kind: '@answer-question', questionId, cancelled: false });
}

export async function respondPlan(planId: string, decision: 'approve' | 'reject'): Promise<void> {
  const sessionId = get().currentId;
  await window.ea.rpc.request('plan/respond', { planId, decision });
  if (sessionId) set((s) => ({ plans: { ...s.plans, [sessionId]: undefined } }));
}

/** Switch the live execution mode for the open session (agent §3.8). */
export async function setExecutionMode(mode: ExecutionMode): Promise<void> {
  const sessionId = get().currentId;
  if (!sessionId) return;
  const prev = get().modes[sessionId];
  set((s) => ({ modes: { ...s.modes, [sessionId]: mode } })); // optimistic
  try {
    await window.ea.rpc.request('mode/set', { sessionId, mode });
  } catch {
    set((s) => ({ modes: { ...s.modes, [sessionId]: prev ?? EXECUTION_MODE.ASK } }));
  }
}

export function dismissToast(sessionId: string, id: string): void {
  dispatch(sessionId, { kind: '@dismiss-toast', id });
}

// ---------------------------------------------------------------------------
// Global wiring — called once from App on mount.
// ---------------------------------------------------------------------------
export async function refreshProfiles(): Promise<void> {
  const res = await window.ea.profiles.list();
  set({ profiles: res.profiles, activeProfileId: res.activeId });
}

export function initBridges(): () => void {
  void refreshProfiles();
  void window.ea.gateway.state().then((gw) => set({ gw }));
  // The connection may ALREADY be up when the renderer mounts (main dialed
  // during window creation) — the connected *transition* below never fires
  // then, so the initial snapshot must trigger the first session-list load.
  void window.ea.rpc.state().then((rpc) => {
    set({ rpc });
    if (rpc.phase === 'connected') void loadSessions();
  });
  void window.ea.settings.get().then((settings) => set({ settings }));
  void window.ea.app.info().then((appInfo) => set({ appInfo }));

  const un1 = window.ea.gateway.onState((gw) => set({ gw }));
  const un2 = window.ea.rpc.onState((rpc) => {
    const prev = get().rpc;
    set({ rpc });
    // Reconnected (app-server §8.1): history is the authority — re-pull.
    if (rpc.phase === 'connected' && prev.phase !== 'connected') {
      void loadSessions().then(() => {
        const cur = get().currentId;
        if (cur) void openSession(cur);
      });
    }
  });
  const un3 = window.ea.rpc.onNotification(handleNotification);
  const un4 = window.ea.app.onUpdateState((update) => set({ update }));
  return () => {
    un1();
    un2();
    un3();
    un4();
  };
}

// Dev/acceptance hook: inject synthetic notifications to exercise the full
// trace rendering (tool/approval/question/sub-agent/todos) without a live model.
declare global {
  interface Window {
    __eaDispatch: typeof handleNotification;
  }
}
window.__eaDispatch = handleNotification;
