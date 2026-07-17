/**
 * Electron main (desktop-app §2/§10): wires ProfileStore, SidecarSupervisor,
 * PanelManager, ConnectionManager, AdminBridge, Tray and the auto-updater, and
 * exposes them to the sandboxed renderer over allowlisted IPC. The renderer
 * never sees tokens, the admin cookie, or any Node capability (§9).
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, session, shell } from 'electron';
import { join } from 'node:path';
import type { AppSettings, GatewaySnapshot, OverlayItem, ProfileInput, Rect, RpcState, UpdateState } from '../shared/ipc.js';
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
let connection: ConnectionManager;
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
  panel?.dispose();
  panel = undefined;
  lastSnapshot = undefined;

  panelWin?.close();
  panelWin = undefined;

  if (!profile) {
    connection.setTarget(undefined);
    return;
  }

  if (profile.mode === 'local') {
    if (!sidecarExists(sidecar)) {
      log(`[desktop] sidecar 缺失：${sidecar.bin}（先跑 pnpm bundle:sidecar）`);
      connection.setTarget(undefined);
      return;
    }
    const manager = createSidecarManager(sidecar, profile.root, profile.rpcPort);
    supervisor = new SidecarSupervisor({
      manager,
      bundledVersion: sidecar.bundledVersion,
      onSnapshot: (snap) => onGatewaySnapshot(snap),
      log,
    });
    panel = new PanelManager({
      sidecarBin: sidecar.bin,
      root: profile.root,
      port: profile.panelPort,
      log,
      setCookie: async ({ url, name, value }) => {
        await session.defaultSession.cookies.set({ url, name, value, sameSite: 'strict' });
      },
    });
    supervisor.begin();
    // First launch bootstraps the data plane (§4.2 / 验收 1); an already-running
    // gateway (CLI/panel-started) is adopted, not respawned (§4.1).
    const snap = supervisor.snapshot();
    if (snap.state === 'stopped') supervisor.start();
    connectLocal(supervisor.snapshot());
  } else {
    connection.setTarget({ url: profile.url!, token: profiles.token(profile.id) });
  }
  // Re-point the browser MCP config at the (possibly changed) active data root
  // so the gateway that serves this profile can reach it.
  void browserMcp?.register();
  tray.update(supervisor?.snapshot() ?? emptySnapshot(), profile.mode === 'local');
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

function connectLocal(snap: GatewaySnapshot): void {
  const url = snap.rpcUrl ?? defaultRpcUrl(profiles.active()?.rpcPort);
  connection.setTarget({ url });
}

function onGatewaySnapshot(snap: GatewaySnapshot): void {
  send('gateway:state', snap);
  connection.setGatewayRestarting(snap.restarting);
  const profile = profiles.active();
  if (profile?.mode === 'local') {
    tray.update(snap, true);
    // The /rpc URL appears (or changes) once the child writes its PID record —
    // re-dial when it differs from what we're connected to (§3.2).
    const target = snap.rpcUrl ?? defaultRpcUrl(profile.rpcPort);
    if (snap.state === 'running' && target !== lastSnapshot?.rpcUrl && target !== connection.currentState().url) {
      connection.setTarget({ url: target });
    }
  }
  lastSnapshot = snap;
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
  ipcMain.handle('profiles:upsert', (_e, input: ProfileInput) => profiles.upsert(input));
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
    if (id === profiles.activeId()) applyActiveProfile(); // re-dial with the new key
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

  ipcMain.handle('rpc:state', () => connection.currentState());
  ipcMain.handle('rpc:request', async (_e, method: string, params?: unknown) => {
    if (typeof method !== 'string' || !(RPC_ALLOW.test(method) || method === 'initialize')) {
      throw new Error(`不允许的 RPC 方法：${method}`);
    }
    return connection.request(method, params);
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
  ipcMain.handle('dialog:openPath', (_e, path: string) => shell.openPath(path));

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
  ipcMain.handle('browser:openFile', (_e, absPath: string) => browser?.previewFile(absPath));
  ipcMain.handle('browser:setOverlay', (_e, title: string, items: OverlayItem[], notice?: string) =>
    browser?.setOverlay(title, items, notice),
  );

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

    connection = new ConnectionManager({
      clientVersion: app.getVersion(),
      onState: (state: RpcState) => send('rpc:state', state),
      onNotification: (n) => send('rpc:notification', n),
      log,
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
    supervisor?.dispose();
    panel?.dispose();
    connection?.dispose();
    tray?.dispose();
  });
}
