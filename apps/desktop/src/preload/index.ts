/**
 * Preload (desktop-app §9.1): the ONLY bridge between the sandboxed renderer
 * and main. Exposes a fixed, promise-based API — no raw ipcRenderer, no Node.
 * Event channels hand back an unsubscribe function.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  BrowserState,
  ConnectionProfile,
  GatewaySnapshot,
  OverlayItem,
  ProfileInput,
  Rect,
  RpcState,
  UpdateState,
} from '../shared/ipc.js';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener as never);
  return () => ipcRenderer.removeListener(channel, listener as never);
}

const api = {
  profiles: {
    list: (): Promise<{ profiles: ConnectionProfile[]; activeId?: string }> => ipcRenderer.invoke('profiles:list'),
    upsert: (input: ProfileInput): Promise<ConnectionProfile> => ipcRenderer.invoke('profiles:upsert', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('profiles:remove', id),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke('profiles:setActive', id),
    /** Write-only: the key never comes back (§9.2). */
    setToken: (id: string, token: string | null): Promise<void> => ipcRenderer.invoke('profiles:setToken', id, token),
  },
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:update', patch),
  },
  gateway: {
    state: (): Promise<GatewaySnapshot> => ipcRenderer.invoke('gateway:state'),
    start: (): Promise<GatewaySnapshot | undefined> => ipcRenderer.invoke('gateway:start'),
    stop: (): Promise<GatewaySnapshot | undefined> => ipcRenderer.invoke('gateway:stop'),
    restart: (): Promise<GatewaySnapshot | undefined> => ipcRenderer.invoke('gateway:restart'),
    openLogs: (): Promise<void> => ipcRenderer.invoke('gateway:openLogs'),
    onState: (cb: (snap: GatewaySnapshot) => void): (() => void) => on('gateway:state', cb),
  },
  rpc: {
    state: (): Promise<RpcState> => ipcRenderer.invoke('rpc:state'),
    request: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('rpc:request', method, params),
    onState: (cb: (state: RpcState) => void): (() => void) => on('rpc:state', cb),
    onNotification: (cb: (n: { method: string; params?: unknown }) => void): (() => void) =>
      on('rpc:notification', cb),
  },
  panel: {
    /** Open (or focus) the gateway config panel in its own window (§6.1). */
    open: (): Promise<string> => ipcRenderer.invoke('panel:open'),
  },
  dialog: {
    /** Native directory picker; resolves the chosen path, or undefined if cancelled. */
    selectDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('dialog:selectDirectory'),
    /** Open a file/path in the OS default app; resolves '' on success or an error string. */
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('dialog:openPath', path),
  },
  browser: {
    getState: (): Promise<BrowserState> => ipcRenderer.invoke('browser:getState'),
    newTab: (url?: string): Promise<string> => ipcRenderer.invoke('browser:newTab', url),
    openFile: (absPath: string): Promise<string> => ipcRenderer.invoke('browser:openFile', absPath),
    setOverlay: (title: string, items: OverlayItem[], notice?: string): Promise<void> =>
      ipcRenderer.invoke('browser:setOverlay', title, items, notice),
    closeTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:closeTab', id),
    selectTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:selectTab', id),
    navigate: (id: string | undefined, url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', id, url),
    goBack: (id?: string): Promise<void> => ipcRenderer.invoke('browser:goBack', id),
    goForward: (id?: string): Promise<void> => ipcRenderer.invoke('browser:goForward', id),
    reload: (id?: string): Promise<void> => ipcRenderer.invoke('browser:reload', id),
    /** Position the native web view over the renderer's content placeholder. */
    setBounds: (rect: Rect): Promise<void> => ipcRenderer.invoke('browser:setBounds', rect),
    show: (): Promise<void> => ipcRenderer.invoke('browser:show'),
    hide: (): Promise<void> => ipcRenderer.invoke('browser:hide'),
    onState: (cb: (s: BrowserState) => void): (() => void) => on('browser:state', cb),
    // Standalone popup window controls (main window drives these).
    openWindow: (): Promise<void> => ipcRenderer.invoke('browser:openWindow'),
    closeWindow: (): Promise<void> => ipcRenderer.invoke('browser:closeWindow'),
    toggleWindow: (): Promise<void> => ipcRenderer.invoke('browser:toggleWindow'),
    isWindowOpen: (): Promise<boolean> => ipcRenderer.invoke('browser:isWindowOpen'),
    onWindowState: (cb: (s: { open: boolean }) => void): (() => void) => on('browser:windowState', cb),
  },
  app: {
    info: (): Promise<{ appVersion: string; electron: string; bundledGateway?: string; platform: string }> =>
      ipcRenderer.invoke('app:info'),
    checkUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),
    installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onUpdateState: (cb: (state: UpdateState) => void): (() => void) => on('update:state', cb),
    /** Nudge the main window when a card needs the user but focus is elsewhere. */
    flashMain: (): Promise<void> => ipcRenderer.invoke('app:flashMain'),
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('ea', api);
