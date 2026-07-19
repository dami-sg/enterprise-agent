/**
 * Electron main (desktop-app §2/§10): wires ProfileStore, SidecarSupervisor,
 * PanelManager, ConnectionManager, AdminBridge, Tray and the auto-updater, and
 * exposes them to the sandboxed renderer over allowlisted IPC. The renderer
 * never sees tokens, the admin cookie, or any Node capability (§9).
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import type { Artifact } from '@dami-sg/agent-contract';
import type {
  AppSettings,
  ArtifactWindowState,
  ConnectionProfile,
  GatewaySnapshot,
  OverlayItem,
  ProfileInput,
  Rect,
  RpcState,
  UpdateState,
} from '../shared/ipc.js';
import { resolveLang, t } from '../shared/i18n.js';
import { ProfileStore } from './profiles.js';
import { SidecarSupervisor } from './supervisor.js';
import { createSidecarManager, resolveSidecar, sidecarExists } from './sidecar.js';
import { PanelManager } from './panel.js';
import { ConnectionManager } from './connection.js';
import { TrayController } from './tray.js';
import { setupUpdater, type UpdaterHandle } from './updater.js';
import { BrowserManager } from './browser.js';
import { BrowserMcpServer } from './browser-mcp.js';

const defaultRpcUrl = (rpcPort?: number): string => `ws://127.0.0.1:${rpcPort ?? 7320}/rpc`;
/** RPC methods the renderer may call (app-server §5) — everything else is refused. */
const RPC_ALLOW = /^(session|turn|approval|question|plan|mode|models|usage|event)\//;

const log = (line: string): void => {
  console.log(line);
};

let win: BrowserWindow | undefined;
let panelWin: BrowserWindow | undefined;
let browserWin: BrowserWindow | undefined;
let artifactWin: BrowserWindow | undefined;
/** Latest artifact pushed to the preview window — replayed to a late-mounting or
 *  re-shown window renderer via `artifact:getState`. */
let artifactState: ArtifactWindowState = { status: 'empty' };
let quitting = false;

const sidecar = resolveSidecar({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
});
/** Generated icons (scripts/gen-icons.mjs) — sibling of the sidecar assets. */
const iconsDir = app.isPackaged
  ? join(process.resourcesPath, 'icons')
  : join(app.getAppPath(), 'resources', 'icons');

let profiles: ProfileStore;
let supervisor: SidecarSupervisor | undefined;
let panel: PanelManager | undefined;
/** One live connection PER configured profile (multi-gateway §7): every gateway
 *  streams concurrently; the renderer routes requests by profileId. */
const connections = new Map<string, ConnectionManager>();
/** Last dialed target per profile — avoids re-dial churn on reconcile. */
const connTargets = new Map<string, string>();
/** The local profile whose sidecar the supervisor currently manages. */
let supervisedProfileId: string | undefined;
let tray: TrayController;
let updater: UpdaterHandle;
let lastSnapshot: GatewaySnapshot | undefined;
let browser: BrowserManager | undefined;
let browserMcp: BrowserMcpServer | undefined;

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Push to the standalone browser window's renderer (its chrome). */
function sendToBrowser(channel: string, payload: unknown): void {
  if (browserWin && !browserWin.isDestroyed()) browserWin.webContents.send(channel, payload);
}

/** Push to the standalone artifact-preview window's renderer. */
function sendToArtifact(channel: string, payload: unknown): void {
  if (artifactWin && !artifactWin.isDestroyed()) artifactWin.webContents.send(channel, payload);
}

/** Renderer-supplied paths that reach the OS opener / file:// preview must be
 *  absolute and free of `..` — artifact relative paths are agent-controlled, so
 *  a traversal segment must never make it through (§9). */
function assertPlainAbsolutePath(p: string): string {
  if (typeof p !== 'string' || !isAbsolute(p) || normalize(p).split(sep).includes('..')) {
    throw new Error(`非法路径：${String(p)}`);
  }
  return p;
}

/** Path for staging an artifact in the session-transient temp dir (wiped on
 *  quit), keyed by artifact id so repeat opens overwrite. */
function stagedArtifactPath(artifactId: string, filename: string): string {
  const dir = join(app.getPath('temp'), 'ea-artifact-preview', basename(artifactId));
  mkdirSync(dir, { recursive: true });
  const safe = basename(filename).replace(/[<>:"|?*]/g, '_') || 'file';
  return join(dir, safe);
}

/** Ceiling for a staged artifact download — a runaway multi-GB file would grind
 *  the ws connection for minutes; beyond this we fail loud instead. */
const DOWNLOAD_MAX = 1024 * 1024 * 1024;
/** Matches the host's per-call readArtifact cap. */
const DOWNLOAD_CHUNK = 8 * 1024 * 1024;

/** In-flight downloads keyed by staged path — a second request for the same
 *  artifact joins the running one instead of opening a second 'w' fd on the
 *  same file (interleaved writes + the loser's rmSync would corrupt it). */
const downloadsInFlight = new Map<string, Promise<string>>();

/** Download an artifact of ANY size to a staged temp file by paging
 *  `session/artifactContent` with byte ranges — chunks stream to disk here in
 *  main, so the renderer never holds a multi-hundred-MB base64 string. */
function downloadArtifact(
  profileId: string,
  sessionId: string,
  artifactId: string,
  filename: string,
): Promise<string> {
  const abs = stagedArtifactPath(artifactId, filename);
  const existing = downloadsInFlight.get(abs);
  if (existing) return existing;
  const run = downloadArtifactTo(abs, profileId, sessionId, artifactId).finally(() => downloadsInFlight.delete(abs));
  downloadsInFlight.set(abs, run);
  return run;
}

async function downloadArtifactTo(
  abs: string,
  profileId: string,
  sessionId: string,
  artifactId: string,
): Promise<string> {
  const fd = openSync(abs, 'w');
  try {
    let offset = 0;
    for (;;) {
      const r = (await connFor(profileId).request('session/artifactContent', {
        sessionId,
        artifactId,
        offset,
        length: DOWNLOAD_CHUNK,
      })) as { base64: string; truncated: boolean; size: number };
      if (r.size > DOWNLOAD_MAX) throw new Error(`artifact exceeds ${DOWNLOAD_MAX / (1024 * 1024 * 1024)}GB download limit`);
      const buf = Buffer.from(r.base64, 'base64');
      writeSync(fd, buf);
      offset += buf.length;
      // Pre-range gateways ignore offset/length and omit `size` — paging would
      // re-read the same first chunk forever, so stop after one (8MB-capped) read.
      if (typeof r.size !== 'number') break;
      if (!r.truncated || buf.length === 0 || offset >= r.size) break;
    }
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
    rmSync(abs, { force: true });
    throw err;
  }
  closeSync(fd);
  return abs;
}

/** Lazily create the standalone browser window (the embedded browser lives in its
 *  OWN OS window now — a popup, not a panel). Its renderer loads the app shell at
 *  `#browser`, which renders only the browser chrome; the tab WebContentsViews and
 *  the activity overlay attach to THIS window's contentView. Closing hides it (so
 *  tabs / logins persist); it's destroyed only on quit. */
function ensureBrowserWindow(): BrowserWindow {
  if (browserWin && !browserWin.isDestroyed()) return browserWin;
  const w = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: t(resolveLang(profiles.settings().language, app.getLocale()), 'tabBrowser'),
    icon: process.platform === 'linux' ? join(iconsDir, 'app.png') : undefined,
    // Frameless like the main window: traffic lights inset onto the tab strip,
    // which reserves ml-[70px] and is the drag region (desktop-app §8.3).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Close = hide (keep the session/tabs alive); real teardown happens on quit.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
    send('browser:windowState', { open: false });
  });
  w.on('closed', () => {
    browserWin = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#browser`);
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'browser' });
  }
  browserWin = w;
  return w;
}

function showBrowserWindow(): void {
  const w = ensureBrowserWindow();
  w.show();
  w.focus();
  // Ensure an active tab exists immediately (the model may `navigate` before the
  // popup's renderer has mounted and called show()).
  browser?.show();
  send('browser:windowState', { open: true });
}

function hideBrowserWindow(): void {
  if (browserWin && !browserWin.isDestroyed() && browserWin.isVisible()) browserWin.hide();
  send('browser:windowState', { open: false });
}

function browserWindowOpen(): boolean {
  return !!browserWin && !browserWin.isDestroyed() && browserWin.isVisible();
}

/** Lazily create the standalone artifact-preview window (desktop-app §artifacts):
 *  a frameless popup whose renderer loads the app shell at `#artifact` and draws
 *  the preview full-window (react-markdown / iframe / image). Unlike the browser
 *  window there's no native WebContentsView — it's plain renderer DOM fed the
 *  file bytes over IPC. Closing hides it (state is kept so a re-open is instant);
 *  it's destroyed only on quit. */
function ensureArtifactWindow(): BrowserWindow {
  if (artifactWin && !artifactWin.isDestroyed()) return artifactWin;
  const w = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    show: false,
    title: t(resolveLang(profiles.settings().language, app.getLocale()), 'artifactPreviewTitle'),
    icon: process.platform === 'linux' ? join(iconsDir, 'app.png') : undefined,
    // Frameless like the main/browser windows: traffic lights inset onto the
    // header, which reserves ml-[70px] as the drag region (desktop-app §8.3).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 12 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Close = hide (keep the last preview so re-open is instant); teardown on quit.
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  w.on('closed', () => {
    artifactWin = undefined;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#artifact`);
  } else {
    void w.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: 'artifact' });
  }
  artifactWin = w;
  return w;
}

/** Replace the preview window's state and push it; opens/focuses the window. */
function setArtifactState(next: ArtifactWindowState): void {
  artifactState = next;
  const w = ensureArtifactWindow();
  sendToArtifact('artifact:state', artifactState);
  if (!w.isVisible()) w.show();
  w.focus();
}

/** The active profile's MCP config dir (`<root>/mcp`) — where the browser MCP
 *  server registers itself so the local gateway's agent auto-connects. */
function mcpDir(): string {
  const root = profiles.active()?.root ?? join(app.getPath('home'), '.enterprise-agent');
  return join(root, 'mcp');
}

// ---------------------------------------------------------------------------
// Active-profile lifecycle (§3): local ⇒ supervise sidecar + panel; remote ⇒
// connection only. Switching tears down supervision but NEVER stops a resident
// local gateway (it outlives the UI by design, §4.4).
// ---------------------------------------------------------------------------
function applyActiveProfile(): void {
  const profile = profiles.active();
  supervisor?.dispose();
  supervisor = undefined;
  supervisedProfileId = undefined;
  panel?.dispose();
  panel = undefined;
  lastSnapshot = undefined;

  panelWin?.close();
  panelWin = undefined;

  // Multi-gateway (§7): the LOCAL sidecar is supervised whenever a local
  // profile EXISTS — not only when it's active. Otherwise an app start with a
  // remote profile active leaves the local gateway down (and its conversations
  // dead) even though its connection keeps dialing.
  const localProfile = profile?.mode === 'local' ? profile : profiles.list().find((p) => p.mode === 'local');

  if (localProfile) {
    if (!sidecarExists(sidecar)) {
      log(`[desktop] sidecar 缺失：${sidecar.bin}（先跑 pnpm bundle:sidecar）`);
    } else {
      const manager = createSidecarManager(sidecar, localProfile.root, localProfile.rpcPort);
      supervisor = new SidecarSupervisor({
        manager,
        bundledVersion: sidecar.bundledVersion,
        onSnapshot: (snap) => onGatewaySnapshot(snap),
        log,
      });
      panel = new PanelManager({
        sidecarBin: sidecar.bin,
        root: localProfile.root,
        port: localProfile.panelPort,
        log,
        setCookie: async ({ url, name, value }) => {
          // httpOnly: the panel web app never reads it (its own Set-Cookie is
          // HttpOnly too) — keep it away from any script on that origin.
          await session.defaultSession.cookies.set({ url, name, value, sameSite: 'strict', httpOnly: true });
        },
      });
      supervisedProfileId = localProfile.id;
      supervisor.begin();
      // First launch bootstraps the data plane (§4.2 / 验收 1); an already-running
      // gateway (CLI/panel-started) is adopted, not respawned (§4.1).
      const snap = supervisor.snapshot();
      if (snap.state === 'stopped') supervisor.start();
      lastSnapshot = supervisor.snapshot();
    }
  }
  // EVERY profile keeps a live connection regardless of which one is active —
  // switching only changes what the supervisor/panel manage.
  ensureConnections();
  // supervisor.begin() fired its first snapshot BEFORE the connection existed —
  // propagate the restarting flag it couldn't deliver then.
  if (supervisedProfileId && lastSnapshot) {
    connections.get(supervisedProfileId)?.setGatewayRestarting(lastSnapshot.restarting);
  }
  // Re-point the browser MCP config at the (possibly changed) active data root
  // so the gateway that serves this profile can reach it.
  void browserMcp?.register();
  tray.update(supervisor?.snapshot() ?? emptySnapshot(), !!supervisor);
}

/** Theme (§设置): nativeTheme.themeSource drives BOTH the window chrome and the
 *  renderer's `prefers-color-scheme`, so the renderer just mirrors the media
 *  query — no duplicated "effective theme" logic. */
function applyTheme(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

function emptySnapshot(): GatewaySnapshot {
  return {
    state: 'stopped',
    stale: false,
    restarting: false,
    autoRestart: 'armed',
    crashCount: 0,
    bundledVersion: sidecar.bundledVersion,
    versionMismatch: false,
  };
}

// ---------------------------------------------------------------------------
// Multi-gateway connections (§7 revised): one ConnectionManager per profile,
// ALL live concurrently — the renderer renders every gateway's sessions in real
// time and routes requests by profileId; nothing disconnects on profile switch.
// ---------------------------------------------------------------------------

function connFor(profileId: string): ConnectionManager {
  const conn = connections.get(profileId);
  if (!conn) throw new Error(`未知连接：${profileId}`);
  return conn;
}

/** The desired dial target for a profile: local → the sidecar /rpc (supervisor
 *  snapshot URL for the ACTIVE local profile, default port otherwise — a
 *  resident gateway answers even when we don't supervise it); remote → its URL
 *  + bearer key. */
function targetFor(profile: ConnectionProfile): { url: string; token?: string } {
  if (profile.mode === 'local') {
    const supervised = profile.id === supervisedProfileId ? lastSnapshot?.rpcUrl : undefined;
    return { url: supervised ?? defaultRpcUrl(profile.rpcPort) };
  }
  return { url: profile.url!, token: profiles.token(profile.id) };
}

/** Reconcile the connection map against the profile list: create/dial missing,
 *  re-dial changed targets, dispose removed. Cheap to call on any change. */
function ensureConnections(): void {
  const list = profiles.list();
  const seen = new Set<string>();
  for (const profile of list) {
    seen.add(profile.id);
    let conn = connections.get(profile.id);
    if (!conn) {
      const profileId = profile.id;
      conn = new ConnectionManager({
        clientVersion: app.getVersion(),
        onState: (state: RpcState) => send('rpc:state', { profileId, state }),
        onNotification: (n) => send('rpc:notification', { profileId, ...n }),
        log: (line) => log(`[rpc:${profile.name}] ${line.replace(/^\[rpc\] /, '')}`),
      });
      connections.set(profileId, conn);
    }
    const target = targetFor(profile);
    const key = `${target.url}|${target.token ?? ''}`;
    if (connTargets.get(profile.id) !== key) {
      connTargets.set(profile.id, key);
      conn.setTarget(target);
    }
  }
  for (const [id, conn] of connections) {
    if (!seen.has(id)) {
      conn.dispose();
      connections.delete(id);
      connTargets.delete(id);
    }
  }
}

function onGatewaySnapshot(snap: GatewaySnapshot): void {
  send('gateway:state', snap);
  if (supervisedProfileId) {
    connections.get(supervisedProfileId)?.setGatewayRestarting(snap.restarting);
    tray.update(snap, true);
  }
  lastSnapshot = snap;
  // The /rpc URL appears (or changes) once the child writes its PID record —
  // the reconcile re-dials only when the target actually differs (§3.2).
  ensureConnections();
}

// ---------------------------------------------------------------------------
// Panel window (§6.1, revised): "网关配置" in settings opens the full Web panel
// in its own window. It shares the default session, so the admin cookie the
// PanelManager injected logs it in automatically — an external browser would
// hit the login screen instead.
// ---------------------------------------------------------------------------
async function openPanelWindow(): Promise<string> {
  if (!panel) throw new Error('当前 profile 不是 local 模式');
  const url = await panel.ensure();
  if (panelWin && !panelWin.isDestroyed()) {
    panelWin.focus();
    return url;
  }
  panelWin = new BrowserWindow({
    width: 1080,
    height: 760,
    title: t(resolveLang(profiles.settings().language, app.getLocale()), 'panelTitle'),
    icon: process.platform === 'linux' ? join(iconsDir, 'app.png') : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // This window rides the default session, which carries the ADMIN cookie —
  // it must never navigate off the panel origin or spawn native windows (§9.1).
  const panelOrigin = new URL(url).origin;
  panelWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://') || u.startsWith('https://')) void shell.openExternal(u);
    return { action: 'deny' };
  });
  panelWin.webContents.on('will-navigate', (event, navUrl) => {
    if (URL.parse(navUrl)?.origin !== panelOrigin) event.preventDefault();
  });
  panelWin.on('closed', () => {
    panelWin = undefined;
  });
  await panelWin.loadURL(url);
  return url;
}

// ---------------------------------------------------------------------------
// IPC surface (§10) — all invoke-based, allowlisted in preload.
// ---------------------------------------------------------------------------
function registerIpc(): void {
  ipcMain.handle('profiles:list', () => ({ profiles: profiles.list(), activeId: profiles.activeId() }));
  ipcMain.handle('profiles:upsert', (_e, input: ProfileInput) => {
    const saved = profiles.upsert(input);
    ensureConnections(); // dial the new/edited target right away
    return saved;
  });
  ipcMain.handle('profiles:remove', (_e, id: string) => {
    profiles.remove(id);
    applyActiveProfile();
  });
  ipcMain.handle('profiles:setActive', (_e, id: string) => {
    profiles.setActive(id);
    applyActiveProfile();
  });
  ipcMain.handle('profiles:setToken', (_e, id: string, token: string | null) => {
    profiles.setToken(id, token);
    // Re-dial that profile with the new key (targetFor folds the token in).
    connTargets.delete(id);
    ensureConnections();
  });

  ipcMain.handle('settings:get', () => profiles.settings());
  ipcMain.handle('settings:update', (_e, patch: Partial<AppSettings>) => {
    const next = profiles.updateSettings(patch);
    applyTheme(next.theme);
    tray?.setLanguage(next.language);
    return next;
  });

  ipcMain.handle('gateway:state', () => supervisor?.snapshot() ?? emptySnapshot());
  ipcMain.handle('gateway:start', () => supervisor?.start());
  ipcMain.handle('gateway:stop', () => supervisor?.stop());
  ipcMain.handle('gateway:restart', () => supervisor?.restart());
  ipcMain.handle('gateway:openLogs', () => {
    const profile = profiles.active();
    if (profile?.mode !== 'local') return;
    const root = profile.root ?? join(app.getPath('home'), '.enterprise-agent');
    shell.showItemInFolder(join(root, 'gateway', 'gateway.log'));
  });

  // Per-profile connection states, keyed by profileId (multi-gateway §7).
  ipcMain.handle('rpc:state', () =>
    Object.fromEntries([...connections].map(([id, conn]) => [id, conn.currentState()])),
  );
  ipcMain.handle('rpc:request', async (_e, profileId: string, method: string, params?: unknown) => {
    if (typeof method !== 'string' || !(RPC_ALLOW.test(method) || method === 'initialize')) {
      throw new Error(`不允许的 RPC 方法：${method}`);
    }
    return connFor(profileId).request(method, params);
  });

  ipcMain.handle('panel:open', () => openPanelWindow());
  // Native directory picker for choosing a new session's working directory.
  ipcMain.handle('dialog:selectDirectory', async () => {
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled || !res.filePaths[0] ? undefined : res.filePaths[0];
  });
  // Open an artifact file in the OS default app (local sessions only). Returns
  // an error string on failure (e.g. the file is on a remote gateway).
  ipcMain.handle('dialog:openPath', (_e, path: string) => shell.openPath(assertPlainAbsolutePath(path)));

  // Embedded browser control (§browser) — the renderer drives the native tabs.
  ipcMain.handle('browser:getState', () => browser?.state() ?? { tabs: [] });
  ipcMain.handle('browser:newTab', (_e, url?: string) => browser?.newTab(url));
  ipcMain.handle('browser:closeTab', (_e, id: string) => browser?.closeTab(id));
  ipcMain.handle('browser:selectTab', (_e, id: string) => browser?.selectTab(id));
  ipcMain.handle('browser:navigate', (_e, id: string | undefined, url: string) => browser?.navigate(id, url));
  ipcMain.handle('browser:goBack', (_e, id?: string) => browser?.goBack(id));
  ipcMain.handle('browser:goForward', (_e, id?: string) => browser?.goForward(id));
  ipcMain.handle('browser:reload', (_e, id?: string) => browser?.reload(id));
  ipcMain.handle('browser:setBounds', (_e, rect: Rect) => browser?.setBounds(rect));
  ipcMain.handle('browser:show', () => browser?.show());
  ipcMain.handle('browser:hide', () => browser?.hide());
  // Standalone browser window (popup) lifecycle.
  ipcMain.handle('browser:openWindow', () => showBrowserWindow());
  ipcMain.handle('browser:closeWindow', () => hideBrowserWindow());
  ipcMain.handle('browser:toggleWindow', () => (browserWindowOpen() ? hideBrowserWindow() : showBrowserWindow()));
  ipcMain.handle('browser:isWindowOpen', () => browserWindowOpen());
  // Open a local file (an artifact) in a trusted preview tab.
  ipcMain.handle('browser:openFile', (_e, absPath: string) => browser?.previewFile(assertPlainAbsolutePath(absPath)));
  // Download an artifact (chunked, any size) to a staged temp file, then open
  // it: `browser` → trusted preview tab (Chromium renders HTML/PDF natively) +
  // show the browser window; `os` → the OS default app. Used whenever the
  // renderer can't address the file by path (scratch sessions, remote profiles).
  ipcMain.handle(
    'artifact:download',
    async (_e, profileId: string, sessionId: string, artifactId: string, filename: string, target: 'browser' | 'os') => {
      const abs = await downloadArtifact(profileId, sessionId, artifactId, filename);
      if (target === 'browser') {
        browser?.previewFile(abs);
        showBrowserWindow();
        return '';
      }
      return shell.openPath(abs);
    },
  );
  ipcMain.handle('browser:setOverlay', (_e, title: string, items: OverlayItem[], notice?: string) =>
    browser?.setOverlay(title, items, notice),
  );

  // Standalone artifact-preview window (§artifacts). The main app window fetches
  // the bytes over RPC and pushes them here; the preview window is presentational.
  ipcMain.handle('artifact:open', (_e, artifact: Artifact, sessionId?: string, absPath?: string, profileId?: string) =>
    setArtifactState({ artifact, sessionId, profileId, absPath, status: 'loading' }),
  );
  // The id guard drops a fetch that resolved after the user opened a newer
  // artifact — otherwise stale bytes would paint under the current header.
  ipcMain.handle('artifact:content', (_e, artifactId: string, base64: string, truncated: boolean) => {
    if (artifactState.artifact?.id !== artifactId) return;
    setArtifactState({ ...artifactState, base64, truncated, status: 'ready' });
  });
  ipcMain.handle('artifact:error', (_e, artifactId: string) => {
    if (artifactState.artifact?.id !== artifactId) return;
    setArtifactState({ ...artifactState, status: 'error' });
  });
  ipcMain.handle('artifact:getState', () => artifactState);
  ipcMain.handle('artifact:close', () => {
    if (artifactWin && !artifactWin.isDestroyed() && artifactWin.isVisible()) artifactWin.hide();
  });

  ipcMain.handle('app:info', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    bundledGateway: sidecar.bundledVersion,
    platform: process.platform,
  }));
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.quitAndInstall());
  // Nudge the main window (dock bounce / taskbar flash) when it has a card the
  // user must act on but is focused elsewhere (e.g. the browser popup).
  ipcMain.handle('app:flashMain', () => {
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
}

// ---------------------------------------------------------------------------
// Window & app lifecycle
// ---------------------------------------------------------------------------
function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Enterprise Agent',
    // Frameless with the traffic lights inset onto the top-left of our own header
    // (the header reserves ml-[70px] and is the drag region). macOS-only; other
    // platforms keep their default frame (desktop-app §8.3, macOS-first).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 14 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links open in the system browser; the window never navigates away (§9.1).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) event.preventDefault();
  });

  win.on('closed', () => {
    win = undefined;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

// Test/dev isolation: point userData (profiles, session state) at a scratch dir
// so acceptance runs never touch the operator's real profiles (§12 验收).
if (process.env.EA_DESKTOP_USERDATA) app.setPath('userData', process.env.EA_DESKTOP_USERDATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });

  void app.whenReady().then(async () => {
    const { safeStorage } = await import('electron');
    profiles = new ProfileStore({
      dir: app.getPath('userData'),
      encrypt: (plain) =>
        safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : Buffer.from(plain, 'utf8'),
      decrypt: (blob) =>
        safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(blob) : blob.toString('utf8'),
    });

    tray = new TrayController({
      iconPath: join(iconsDir, 'trayTemplate.png'),
      systemLocale: app.getLocale(),
      log,
      onShow: () => (win ? win.show() : createWindow()),
      onStart: () => supervisor?.start(),
      onStop: () => supervisor?.stop(),
      onRestart: () => supervisor?.restart(),
      onQuit: () => app.quit(),
    });
    // Best-effort: a broken updater must never block boot.
    updater = await setupUpdater({
      isPackaged: app.isPackaged,
      onState: (state: UpdateState) => send('update:state', state),
      log,
    }).catch((err) => {
      log(`[updater] setup 失败：${(err as Error).message}`);
      return { check: async () => {}, quitAndInstall: () => {} };
    });

    // Dev runs show the default Electron dock icon — replace it with ours
    // (packaged builds get it from the bundle's icns).
    if (!app.isPackaged && process.platform === 'darwin') {
      const dockIcon = nativeImage.createFromPath(join(iconsDir, 'app.png'));
      if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
    }

    // The app's own windows (and the admin-cookied panel) never need powerful
    // web permissions — deny requests instead of Electron's permissive default.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

    registerIpc();
    applyTheme(profiles.settings().theme);
    tray.setLanguage(profiles.settings().language);
    tray.attach();
    createWindow();
    // Embedded browser + its loopback MCP server (§browser). start() picks
    // ephemeral ports and writes the MCP config so the local gateway's agent
    // auto-connects; a failed start must never block boot.
    browser = new BrowserManager({ getWindow: () => browserWin, send: sendToBrowser });
    browserMcp = new BrowserMcpServer({ browser, mcpDir });
    await browserMcp.start().catch((err) => log(`[browser-mcp] start 失败：${(err as Error).message}`));
    applyActiveProfile();
    void updater.check();
  });

  app.on('activate', () => {
    if (!win) createWindow();
    else win.show();
  });

  // Window closed ≠ app quit: the tray keeps the control plane alive while the
  // resident gateway keeps serving IM channels (§4.4).
  app.on('window-all-closed', () => {
    /* stay in tray on all platforms */
  });

  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    // Exit policy (§4.4): default leaves the gateway resident; the setting stops it.
    if (profiles?.settings().stopGatewayOnQuit) supervisor?.stop();
    browserMcp?.dispose();
    browser?.dispose();
    if (browserWin && !browserWin.isDestroyed()) browserWin.destroy();
    if (artifactWin && !artifactWin.isDestroyed()) artifactWin.destroy();
    // Staged artifact-preview bytes are session-transient — wipe them.
    rmSync(join(app.getPath('temp'), 'ea-artifact-preview'), { recursive: true, force: true });
    supervisor?.dispose();
    panel?.dispose();
    for (const conn of connections.values()) conn.dispose();
    connections.clear();
    tray?.dispose();
  });
}
