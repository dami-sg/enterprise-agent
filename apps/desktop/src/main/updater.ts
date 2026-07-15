/**
 * Auto-update wiring (desktop-app §8.2): electron-updater against GitHub
 * Releases (electron-builder `publish`). Update *download* is automatic;
 * *installing* waits for the user (quitAndInstall via IPC) — and after the app
 * relaunches, the §4.5 version-alignment banner picks up the sidecar restart.
 * Silently inert in dev (not packaged) or when no publish config is present.
 */
import type { UpdateState } from '../shared/ipc.js';

export interface UpdaterDeps {
  isPackaged: boolean;
  onState: (state: UpdateState) => void;
  log?: (line: string) => void;
}

export interface UpdaterHandle {
  check(): Promise<void>;
  quitAndInstall(): void;
}

export async function setupUpdater(deps: UpdaterDeps): Promise<UpdaterHandle> {
  const log = deps.log ?? (() => {});
  if (!deps.isPackaged) {
    deps.onState({ phase: 'idle' });
    return { check: async () => {}, quitAndInstall: () => {} };
  }
  // Lazy import: electron-updater reads app metadata at import time; keep dev clean.
  // It ships as CJS and stays external in the bundle, so the namespace may carry
  // the exports directly OR under `default` — take whichever is present. Any
  // failure here must not brick app boot (the updater is best-effort).
  let autoUpdater: import('electron-updater').AppUpdater;
  try {
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: import('electron-updater').AppUpdater;
      default?: { autoUpdater?: import('electron-updater').AppUpdater };
    };
    const resolved = mod.autoUpdater ?? mod.default?.autoUpdater;
    if (!resolved) throw new Error('electron-updater autoUpdater export missing');
    autoUpdater = resolved;
  } catch (err) {
    log(`[updater] 初始化失败：${(err as Error).message}`);
    deps.onState({ phase: 'error', error: (err as Error).message });
    return { check: async () => {}, quitAndInstall: () => {} };
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => deps.onState({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => deps.onState({ phase: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => deps.onState({ phase: 'idle' }));
  autoUpdater.on('update-downloaded', (info) => deps.onState({ phase: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => {
    log(`[updater] ${err.message}`);
    deps.onState({ phase: 'error', error: err.message });
  });

  return {
    check: async () => {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        log(`[updater] check 失败：${(err as Error).message}`);
      }
    },
    quitAndInstall: () => autoUpdater.quitAndInstall(),
  };
}
