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
import type { AgentStreamEvent, Artifact, ExecutionMode, SessionTree, Todo, UsageTotals } from '@dami-sg/agent-contract';
import { EXECUTION_MODE } from '@dami-sg/agent-contract';
import type {
  AppSettings,
  BrowserState,
  ConnectionProfile,
  GatewaySnapshot,
  OverlayItem,
  Rect,
  RpcState,
  UpdateState,
} from '../../shared/ipc.js';
import { I18N, resolveLang, t, type MessageKey } from '../../shared/i18n.js';
import {
  INLINE_IMAGE_MAX,
  INLINE_PDF_MAX,
  buildManifest,
  fileToBase64,
  type AttachmentKind,
  type PendingAttachment,
} from '@/lib/attachments';

export interface SessionMeta {
  id: string;
  name?: string;
  /** Bound working directory (agent §1.1); undefined uses the session scratch dir. */
  workingDir?: string;
}

export interface PendingPlan {
  planId: string;
  plan: string;
}

/** Main view. The browser is NOT here — it's a side panel (`browserOpen`) that
 *  splits 50/50 with Chat, not a full-window tab. */
export type AppTab = 'chat' | 'settings';

/** One model-driven browser action, shown in the Browser overlay while the model
 *  is driving the embedded browser. */
export interface BrowserActivity {
  /** The tool-call id (also de-dupes call vs. result). */
  id: string;
  /** Bare action name, e.g. `navigate`, `click`, `screenshot`. */
  name: string;
  /** One-line argument summary (url / query / ref / …). */
  detail?: string;
  status: 'running' | 'done' | 'error';
  at: number;
}

/** Tool prefix for the desktop's own browser MCP servers (read + write). */
const BROWSER_TOOL_PREFIX = 'mcp__desktop-browser';

interface DesktopState {
  /** Main view (chat vs. settings). The browser is a side panel, not a tab. */
  appTab: AppTab;
  /** Whether the standalone browser window (popup) is open. */
  browserOpen: boolean;
  /** Whether the Chat session-list sidebar is collapsed (hidden). */
  sidebarCollapsed: boolean;
  /** Live log of the model's browser actions (empty when idle). Rendered as a
   *  floating overlay on the browser panel while the model drives it. */
  browserActivity: BrowserActivity[];
  /** True while WE auto-opened the browser panel for a model-driven burst (vs.
   *  the user opening it manually). Drives the auto-close when the turn ends. */
  browserAutoFocused: boolean;
  profiles: ConnectionProfile[];
  activeProfileId?: string;
  gw?: GatewaySnapshot;
  rpc: RpcState;
  settings: AppSettings;
  update: UpdateState;
  appInfo?: { appVersion: string; electron: string; bundledGateway?: string; platform: string };

  sessions: SessionMeta[];
  currentId?: string;
  /** Chosen working dir for the pending new chat (no session yet). Applied when
   *  the first message creates the session; undefined → gateway default. */
  draftWorkingDir?: string;
  /** Chosen execution mode for the pending new chat (no session yet). Applied
   *  once the first message creates the session; undefined → gateway default. */
  draftMode?: ExecutionMode;
  /** Non-markdown artifact open in the in-window modal — the original preview for
   *  remote/scratch sessions (local files open in the Chromium browser instead,
   *  markdown in the standalone window). */
  previewArtifact?: Artifact;
  /** Embedded-browser tab state pushed from main (desktop-app §browser). */
  browser: BrowserState;
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
  /** Orchestrator modalities from models/list (multimodal §3.1) — gates inline
   *  image/PDF attachment parts. Empty until fetched. */
  caps: string[];
  /** An upload+turn-start is in flight (attachments encode/upload before send). */
  sending: boolean;
}

export const useStore = create<DesktopState>(() => ({
  appTab: 'chat',
  browserOpen: false,
  sidebarCollapsed: false,
  browserActivity: [],
  browserAutoFocused: false,
  profiles: [],
  rpc: { phase: 'idle' },
  settings: { stopGatewayOnQuit: false, theme: 'system', language: 'system' },
  update: { phase: 'idle' },
  sessions: [],
  browser: { tabs: [] },
  traces: {},
  plans: {},
  runIds: {},
  modes: {},
  turnUsageBaseline: {},
  lastTurnUsage: {},
  caps: [],
  sending: false,
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

/** Summarise a browser tool call's arguments for the activity overlay. */
function browserActionDetail(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.url === 'string') return i.url;
  if (typeof i.query === 'string') return i.query;
  if (typeof i.text === 'string') return i.text.slice(0, 60);
  if (typeof i.direction === 'string') return String(i.direction);
  if (typeof i.ref === 'number') return `ref ${i.ref}`;
  return undefined;
}

/** Whether the current session has a card (approval / question / plan) waiting
 *  for the user — which lives in the MAIN window and is invisible from the
 *  browser popup, so we surface a notice there. */
function currentSessionNeedsUser(): boolean {
  const s = get();
  const sid = s.currentId;
  if (!sid) return false;
  const trace = s.traces[sid];
  return !!(trace?.pending.length || trace?.questions.length || s.plans[sid]);
}

/** Push the current activity log (+ an approval notice, if a card is waiting in
 *  the main window) to the native overlay view attached to the browser popup. */
function pushOverlay(): void {
  const items = get()
    .browserActivity.slice(-4)
    .map((a) => ({ name: a.name, detail: a.detail, status: a.status }));
  const notice = currentSessionNeedsUser() ? msg('browserNeedsApproval') : undefined;
  void window.ea.browser.setOverlay(items.length || notice ? msg('browserBusy') : '', items, notice);
}

/** Watch the event stream for the model driving the embedded browser: auto-open
 *  the browser window on each action and log it for the floating overlay. */
function trackBrowserActivity(sessionId: string, event: AgentStreamEvent): void {
  if (sessionId !== get().currentId) return;

  // A card the user must act on appears in the MAIN window — if the browser popup
  // is open (and probably focused), surface a notice there and nudge the main
  // window, else the user never sees it and the turn looks stuck.
  if (event.kind === 'tool-approval-required' || event.kind === 'user-question-required') {
    if (get().browserOpen) {
      pushOverlay();
      void window.ea.app.flashMain();
    }
    return;
  }

  if (event.kind === 'tool-call' && event.toolName.startsWith(BROWSER_TOOL_PREFIX)) {
    const name = event.toolName.replace(/^mcp__desktop-browser(?:-act)?__/, '');
    // Record that WE opened the window (only if it wasn't already open), so we can
    // auto-close when the turn ends — but leave a manually-opened window alone.
    if (!get().browserOpen) set({ browserAutoFocused: true });
    openBrowser();
    set((s) => ({
      browserActivity: [
        ...s.browserActivity.filter((a) => a.id !== event.toolCallId),
        { id: event.toolCallId, name, detail: browserActionDetail(event.input), status: 'running' as const, at: Date.now() },
      ].slice(-24),
    }));
    pushOverlay();
    return;
  }

  if (event.kind === 'tool-result') {
    set((s) => {
      const status: BrowserActivity['status'] = event.isError ? 'error' : 'done';
      const next = s.browserActivity.map((a) => (a.id === event.toolCallId ? { ...a, status } : a));
      return { browserActivity: next };
    });
    pushOverlay();
  }
}

/** End of a turn: if WE auto-opened the browser window, close it and clear the log. */
function endBrowserActivity(): void {
  const s = get();
  if (!s.browserAutoFocused && s.browserActivity.length === 0) return;
  if (s.browserAutoFocused) closeBrowser();
  set({ browserActivity: [] });
  pushOverlay();
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
        // The turn is done — if the model had taken over the browser, hand the
        // view back to where the user was.
        endBrowserActivity();
      }
      break; // also fold run-finish into the trace below
    }
    case 'item/planProposed': {
      // Plan confirmation is a pending card, not a trace item (app-server §5.3).
      set((s) => ({
        plans: { ...s.plans, [sessionId]: { planId: String(p.planId), plan: String(p.plan ?? '') } },
      }));
      if (sessionId === get().currentId && get().browserOpen) {
        pushOverlay();
        void window.ea.app.flashMain();
      }
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
  if (event) {
    dispatch(sessionId, event);
    trackBrowserActivity(sessionId, event);
  }

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
/** Fetch orchestrator modalities (models/list §multimodal) for gating inline
 *  image/PDF attachment parts. An old gateway without the field → empty caps
 *  (attachments still upload; nothing inlines). */
export async function refreshCaps(): Promise<void> {
  const res = (await window.ea.rpc
    .request('models/list', {})
    .catch(() => undefined)) as { orchestrator?: { capabilities?: string[] } } | undefined;
  set({ caps: res?.orchestrator?.capabilities ?? [] });
}

export async function loadSessions(): Promise<void> {
  const res = (await window.ea.rpc.request('session/list', {})) as { sessions: Array<Record<string, unknown>> };
  const metas = res.sessions.map((s) => ({
    id: String(s.id),
    name: typeof s.name === 'string' ? s.name : undefined,
    workingDir: typeof s.workingDir === 'string' ? s.workingDir : undefined,
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
  // Restore the session's artifact manifest for the side panel (agent §artifacts).
  const arts = (await window.ea.rpc.request('session/artifacts', { sessionId }).catch(() => undefined)) as
    | { artifacts?: Artifact[] }
    | undefined;
  if (!stale() && arts?.artifacts) dispatch(sessionId, { kind: '@set-artifacts', artifacts: arts.artifacts });
}

/** Fetch one artifact's bytes (base64) for preview (agent §artifacts). */
export async function fetchArtifactContent(
  sessionId: string,
  artifactId: string,
): Promise<{ artifact: Artifact; base64: string; truncated: boolean } | undefined> {
  return (await window.ea.rpc
    .request('session/artifactContent', { sessionId, artifactId })
    .catch(() => undefined)) as { artifact: Artifact; base64: string; truncated: boolean } | undefined;
}

/** Open an artifact in the OS default app (local sessions only). */
export function openArtifact(sessionId: string, relPath: string): void {
  const wd = get().sessions.find((s) => s.id === sessionId)?.workingDir;
  if (wd) void window.ea.dialog.openPath(joinPath(wd, relPath));
}

export function setAppTab(tab: AppTab): void {
  set({ appTab: tab });
}

export function toggleSidebar(): void {
  set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
}

/** Show the standalone browser window (a popup, separate OS window). */
export function openBrowser(): void {
  void window.ea.browser.openWindow();
  set({ browserOpen: true });
}

/** Hide the standalone browser window. */
export function closeBrowser(): void {
  void window.ea.browser.closeWindow();
  set({ browserOpen: false, browserAutoFocused: false });
}

export function toggleBrowser(): void {
  if (get().browserOpen) closeBrowser();
  else openBrowser();
}

/** Open an http(s) link from the transcript in the built-in browser window
 *  (new tab), instead of the blocked in-window navigation. */
export function openUrlInBrowser(url: string): void {
  void window.ea.browser.newTab(url);
  openBrowser();
}

/** Preview classification, kept local so the store doesn't pull in the preview
 *  React module (same mime/extension rules as artifact-view). */
function artifactPreviewKind(a: Artifact): 'md' | 'html' | 'pdf' | 'other' {
  const mime = a.mimeType ?? '';
  const p = a.path.toLowerCase();
  if (mime === 'text/markdown' || /\.(md|markdown)$/.test(p)) return 'md';
  if (mime === 'text/html' || /\.html?$/.test(p)) return 'html';
  if (mime === 'application/pdf' || p.endsWith('.pdf')) return 'pdf';
  return 'other';
}

/** Preview an artifact, by type:
 *  - markdown → the standalone frameless window (react-markdown + source
 *    toggle; bytes over RPC, so local and remote alike);
 *  - HTML / PDF → ALWAYS the built-in Chromium browser window (native
 *    rendering). With a workingDir the file opens by path; otherwise (scratch
 *    session, remote profile) the bytes are fetched over RPC and staged in a
 *    temp file by main (`browser.openContent`);
 *  - everything else → by path in the browser when local, else the modal. */
export function openArtifactPreview(artifact: Artifact): void {
  const s = get();
  const sessionId = s.currentId;
  if (!sessionId) return;
  const wd = s.sessions.find((x) => x.id === sessionId)?.workingDir;
  const kind = artifactPreviewKind(artifact);
  if (kind === 'md') {
    void window.ea.artifact.open(artifact, wd ? joinPath(wd, artifact.path) : undefined);
    void fetchArtifactContent(sessionId, artifact.id).then((r) => {
      if (r) void window.ea.artifact.content(artifact.id, r.base64, r.truncated);
      else void window.ea.artifact.error(artifact.id);
    });
    return;
  }
  if (wd) {
    void window.ea.browser.openFile(joinPath(wd, artifact.path));
    openBrowser();
    return;
  }
  if (kind === 'html' || kind === 'pdf') {
    void fetchArtifactContent(sessionId, artifact.id).then((r) => {
      // Truncated (>8MB read cap) bytes would render a broken page — fall back
      // to the modal, which shows the same limitation explicitly.
      if (!r || r.truncated) {
        set({ previewArtifact: artifact });
        return;
      }
      const filename = artifact.path.split('/').pop() || artifact.name;
      void window.ea.browser.openContent(artifact.id, filename, r.base64);
      openBrowser();
    });
    return;
  }
  set({ previewArtifact: artifact });
}

/** Preview by id — resolves the full artifact (incl. mimeType) from the open
 *  session so the inline transcript card previews the same way as the panel. */
export function openArtifactPreviewById(id: string): void {
  const s = get();
  const artifact = (s.currentId ? s.traces[s.currentId] : undefined)?.artifacts.find((a) => a.id === id);
  if (artifact) openArtifactPreview(artifact);
}

export function closeArtifactPreview(): void {
  set({ previewArtifact: undefined });
}

function joinPath(dir: string, rel: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[/\\]+$/, '') + sep + rel.replace(/^[/\\]+/, '');
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

export async function createSession(name?: string, workingDir?: string): Promise<string> {
  const fallback = msg('untitledSession');
  const res = (await window.ea.rpc.request('session/create', {
    name: name?.trim() || fallback,
    ...(workingDir ? { workingDir } : {}),
  })) as { session: { id: string } };
  await loadSessions();
  await openSession(res.session.id);
  return res.session.id;
}

/** Enter a draft new chat: no session is created until the first message, so the
 *  working directory can still be chosen (it's fixed at session creation).
 *  `workingDir` pre-selects the dir (e.g. the "+" on a sidebar group). */
export function newChat(workingDir?: string): void {
  set({ currentId: undefined, draftWorkingDir: workingDir, draftMode: undefined });
}

/** Native directory picker for the pending new chat's working directory. */
export async function chooseWorkingDir(): Promise<void> {
  const dir = await window.ea.dialog.selectDirectory();
  if (dir) set({ draftWorkingDir: dir });
}

/** Send a message with optional attachments. Attachments are ALL persisted
 *  server-side into the session's `uploads/` dir first (session/uploadFile);
 *  images/PDFs additionally go inline as UserParts when the orchestrator model
 *  supports the modality (multimodal §3.1). Returns true on success so the
 *  composer knows when to clear the draft + chips — a failed upload leaves them
 *  intact for retry. */
export async function sendMessage(text: string, attachments?: PendingAttachment[]): Promise<boolean> {
  const files = attachments ?? [];
  if (!text.trim() && files.length === 0) return false;
  if (get().sending) return false;
  // Draft new chat (no session yet): create it now with the chosen working dir,
  // named from the first message (or the first attachment). Working dir is fixed
  // at creation, which is why creation is deferred until here.
  let sessionId = get().currentId;
  if (!sessionId) {
    const draftMode = get().draftMode;
    sessionId = await createSession((text.trim() || files[0]?.name || '').slice(0, 40), get().draftWorkingDir);
    // Apply the mode chosen in the draft (setExecutionMode targets currentId,
    // which createSession has now set).
    if (draftMode) await setExecutionMode(draftMode);
  }
  // Mid-run send guard (cli §6.2): a second in-flight turn would strand the
  // running turn's approval/question events.
  if (get().runIds[sessionId]) {
    dispatch(sessionId, { kind: '@toast', level: 'warning', text: msg('turnInProgress') });
    return false;
  }
  set({ sending: true });
  try {
    // Upload phase — BEFORE the optimistic dispatch so a failure leaves the
    // transcript clean and the composer keeps the draft.
    const uploaded: Array<{ path: string; size: number; mime: string; kind: AttachmentKind; base64: string }> = [];
    for (const a of files) {
      let base64: string;
      try {
        base64 = await fileToBase64(a.file);
      } catch (err) {
        dispatch(sessionId, { kind: '@toast', level: 'danger', text: msg('uploadFailed', { error: (err as Error).message }) });
        return false;
      }
      try {
        const r = (await window.ea.rpc.request('session/uploadFile', {
          sessionId,
          filename: a.name,
          base64,
        })) as { path: string; size: number };
        uploaded.push({ path: r.path, size: r.size, mime: a.mime, kind: a.kind, base64 });
      } catch (err) {
        // -32601 METHOD_NOT_FOUND → the connected gateway predates uploadFile.
        const code = (err as { code?: number }).code;
        const old = code === -32601 || /method not found/i.test((err as Error).message ?? '');
        dispatch(sessionId, {
          kind: '@toast',
          level: 'danger',
          text: old ? msg('uploadUnsupported') : msg('uploadFailed', { error: (err as Error).message }),
        });
        return false;
      }
    }
    // Inline parts: image/PDF within the inline caps AND supported by the model.
    const caps = get().caps;
    const parts: Array<Record<string, unknown>> = [];
    for (const u of uploaded) {
      if (u.kind === 'image' && u.size <= INLINE_IMAGE_MAX && caps.includes('image')) {
        parts.push({ type: 'image', data: u.base64, mediaType: u.mime || 'image/png' });
      } else if (u.kind === 'pdf' && u.size <= INLINE_PDF_MAX && caps.includes('pdf')) {
        parts.push({ type: 'file', data: u.base64, mediaType: 'application/pdf', filename: u.path.split('/').pop() });
      }
    }
    const fullText = buildManifest(uploaded, parts.length) + text.trim();
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
    // Optimistic dispatch mirrors exactly what the model sees (manifest + text).
    dispatch(sessionId, { kind: '@user-text', text: fullText });
    try {
      const res = (await window.ea.rpc.request('turn/start', {
        sessionId,
        input: [{ type: 'text', text: fullText }, ...parts],
      })) as { runId: string };
      set((s) => ({ runIds: { ...s.runIds, [sessionId]: res.runId } }));
      return true;
    } catch (err) {
      dispatch(sessionId, {
        kind: '@toast',
        level: 'danger',
        text: msg('sendFailed', { error: (err as Error).message }),
      });
      return false;
    }
  } finally {
    set({ sending: false });
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

/** Dispatch a composer submission: a matching `/command` runs the built-in
 *  (attachments are ignored and stay in the composer); anything else is sent as
 *  a normal message. `sent` → clear draft + chips; `command` → clear draft only;
 *  `failed` → keep both for retry. */
export async function runComposerInput(
  text: string,
  attachments?: PendingAttachment[],
): Promise<'sent' | 'command' | 'failed'> {
  const match = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const cmd = match && SLASH_COMMANDS.find((c) => c.name === match[1]?.toLowerCase());
  if (match && cmd) {
    const sessionId = get().currentId;
    if (sessionId) await cmd.run(sessionId, (match[2] ?? '').trim());
    return 'command';
  }
  return (await sendMessage(text, attachments)) ? 'sent' : 'failed';
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
  pushOverlay(); // clear the browser popup's "approval waiting" notice
}

export async function respondQuestion(questionId: string, answers: Array<{ selected: string[] }>): Promise<void> {
  const sessionId = get().currentId;
  await window.ea.rpc.request('question/respond', { questionId, answers });
  if (sessionId) dispatch(sessionId, { kind: '@answer-question', questionId, cancelled: false });
  pushOverlay();
}

export async function respondPlan(planId: string, decision: 'approve' | 'reject'): Promise<void> {
  const sessionId = get().currentId;
  await window.ea.rpc.request('plan/respond', { planId, decision });
  if (sessionId) set((s) => ({ plans: { ...s.plans, [sessionId]: undefined } }));
  pushOverlay();
}

/** Switch the live execution mode for the open session (agent §3.8). In a draft
 *  new chat (no session yet) it records the choice, applied on first message. */
export async function setExecutionMode(mode: ExecutionMode): Promise<void> {
  const sessionId = get().currentId;
  if (!sessionId) {
    set({ draftMode: mode });
    return;
  }
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
    if (rpc.phase === 'connected') {
      void loadSessions();
      void refreshCaps();
    }
  });
  void window.ea.settings.get().then((settings) => set({ settings }));
  void window.ea.app.info().then((appInfo) => set({ appInfo }));

  const un1 = window.ea.gateway.onState((gw) => set({ gw }));
  const un2 = window.ea.rpc.onState((rpc) => {
    const prev = get().rpc;
    set({ rpc });
    // Reconnected (app-server §8.1): history is the authority — re-pull.
    if (rpc.phase === 'connected' && prev.phase !== 'connected') {
      void refreshCaps();
      void loadSessions().then(() => {
        const cur = get().currentId;
        if (cur) void openSession(cur);
      });
    }
  });
  const un3 = window.ea.rpc.onNotification(handleNotification);
  const un4 = window.ea.app.onUpdateState((update) => set({ update }));
  // The browser tabs live in a separate window now; the main window only tracks
  // whether that popup is open (to reflect it on the toolbar toggle).
  void window.ea.browser.isWindowOpen().then((open) => set({ browserOpen: open }));
  const un5 = window.ea.browser.onWindowState(({ open }) => set({ browserOpen: open }));
  return () => {
    un1();
    un2();
    un3();
    un4();
    un5();
  };
}

/** Minimal bridge for the standalone browser window's renderer: it only needs the
 *  tab state (for the chrome) and settings (for i18n / theme). */
export function initBrowserWindowBridge(): () => void {
  void window.ea.settings.get().then((settings) => set({ settings }));
  void window.ea.browser.getState().then((browser) => set({ browser }));
  return window.ea.browser.onState((browser) => set({ browser }));
}

/** Minimal bridge for the standalone artifact-preview window's renderer: it only
 *  needs settings (for i18n / theme); the artifact state is held locally in the
 *  window component via `window.ea.artifact.getState`/`onState`. */
export function initArtifactWindowBridge(): () => void {
  void window.ea.settings.get().then((settings) => set({ settings }));
  return () => {};
}

// -- embedded browser (desktop-app §browser) --------------------------------
export function browserNavigate(url: string): void {
  void window.ea.browser.navigate(get().browser.activeTabId, url);
}
export function browserNewTab(url?: string): void {
  void window.ea.browser.newTab(url);
}
export function browserCloseTab(id: string): void {
  void window.ea.browser.closeTab(id);
}
export function browserSelectTab(id: string): void {
  void window.ea.browser.selectTab(id);
}
export function browserBack(): void {
  void window.ea.browser.goBack(get().browser.activeTabId);
}
export function browserForward(): void {
  void window.ea.browser.goForward(get().browser.activeTabId);
}
export function browserReload(): void {
  void window.ea.browser.reload(get().browser.activeTabId);
}
export function browserSetBounds(rect: Rect): void {
  void window.ea.browser.setBounds(rect);
}
export function browserShow(): void {
  void window.ea.browser.show();
}
export function browserHide(): void {
  void window.ea.browser.hide();
}

// Dev/acceptance hook: inject synthetic notifications to exercise the full
// trace rendering (tool/approval/question/sub-agent/todos) without a live model.
declare global {
  interface Window {
    __eaDispatch: typeof handleNotification;
  }
}
window.__eaDispatch = handleNotification;
