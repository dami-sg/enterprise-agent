/**
 * Menu-bar tray (desktop-app §11 P2): the status entry point while the window
 * is closed and the gateway keeps running resident (§4.4). Shows sidecar state
 * and offers show-window / start / stop / restart / quit. The icon is the
 * generated `trayTemplate.png` (scripts/gen-icons.mjs) — the "Template" suffix
 * makes macOS recolor it for light/dark menu bars.
 */
import { Menu, Tray, nativeImage } from 'electron';
import type { GatewaySnapshot } from '../shared/ipc.js';
import { resolveLang, t, type Lang } from '../shared/i18n.js';

export interface TrayDeps {
  /** Absolute path to trayTemplate.png (with an @2x sibling). */
  iconPath: string;
  /** OS locale from `app.getLocale()` — used when language setting is `system`. */
  systemLocale: string;
  onShow: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onQuit: () => void;
  log?: (line: string) => void;
}

export class TrayController {
  private tray?: Tray;
  private snap?: GatewaySnapshot;
  private localMode = true;
  private language: 'zh' | 'en' | 'system' = 'system';

  constructor(private readonly deps: TrayDeps) {}

  attach(): void {
    if (this.tray) return;
    const icon = nativeImage.createFromPath(this.deps.iconPath);
    if (icon.isEmpty()) {
      this.deps.log?.(`[tray] 图标加载失败：${this.deps.iconPath}`);
      return; // no invisible ghost tray item
    }
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.render();
  }

  setLanguage(language: 'zh' | 'en' | 'system'): void {
    this.language = language;
    this.render();
  }

  update(snap: GatewaySnapshot, localMode: boolean): void {
    this.snap = snap;
    this.localMode = localMode;
    this.render();
  }

  private lang(): Lang {
    return resolveLang(this.language, this.deps.systemLocale);
  }

  private render(): void {
    if (!this.tray) return;
    const lang = this.lang();
    const stateLabel = !this.localMode
      ? t(lang, 'trayRemote')
      : this.snap?.restarting
        ? t(lang, 'trayRestarting')
        : this.snap?.state === 'running'
          ? t(lang, 'trayRunning', { pid: this.snap.pid ?? '?' })
          : this.snap?.state === 'error'
            ? t(lang, 'trayCrashed')
            : t(lang, 'trayStopped');
    const menu = Menu.buildFromTemplate([
      { label: `Enterprise Agent — ${stateLabel}`, enabled: false },
      { type: 'separator' },
      { label: t(lang, 'trayShow'), click: this.deps.onShow },
      ...(this.localMode
        ? ([
            { type: 'separator' as const },
            { label: t(lang, 'trayStart'), enabled: this.snap?.state !== 'running', click: this.deps.onStart },
            { label: t(lang, 'trayStop'), enabled: this.snap?.state === 'running', click: this.deps.onStop },
            { label: t(lang, 'trayRestart'), enabled: this.snap?.state === 'running', click: this.deps.onRestart },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: t(lang, 'trayQuit'), click: this.deps.onQuit },
    ]);
    this.tray.setToolTip(`Enterprise Agent — ${stateLabel}`);
    this.tray.setContextMenu(menu);
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
