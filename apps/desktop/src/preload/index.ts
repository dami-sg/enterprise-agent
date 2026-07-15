/**
 * Preload (desktop-app §9.1): the ONLY bridge between the sandboxed renderer
 * and main. Exposes a fixed, promise-based API — no raw ipcRenderer, no Node.
 * Event channels hand back an unsubscribe function.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ConnectionProfile,
  GatewaySnapshot,
  ProfileInput,
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
  app: {
    info: (): Promise<{ appVersion: string; electron: string; bundledGateway?: string; platform: string }> =>
      ipcRenderer.invoke('app:info'),
    checkUpdate: (): Promise<void> => ipcRenderer.invoke('update:check'),
    installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onUpdateState: (cb: (state: UpdateState) => void): (() => void) => on('update:state', cb),
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('ea', api);
