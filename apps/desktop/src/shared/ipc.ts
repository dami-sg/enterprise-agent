/**
 * Shared main <-> renderer IPC shapes (desktop-app §10). This module is
 * imported by main, preload, and the renderer (type-only there) — keep it free
 * of Node and Electron imports.
 */
import type { Artifact } from '@dami-sg/agent-contract';

/** A connection target (desktop-app §3.1). Never carries the remote token —
 *  that lives encrypted in the main process (`hasToken` is the only trace). */
export interface ConnectionProfile {
  id: string;
  name: string;
  mode: 'local' | 'remote';
  /** local: App data root (default ~/.enterprise-agent). */
  root?: string;
  /** local: sidecar /rpc port (default 7320) — pin it to run beside another gateway. */
  rpcPort?: number;
  /** local: config panel port (default 7317). */
  panelPort?: number;
  /** remote: ws(s)://host[:port]/rpc. */
  url?: string;
  /** remote: a bearer key is stored (encrypted) for this profile. */
  hasToken: boolean;
}

export type ProfileInput = Omit<ConnectionProfile, 'hasToken'>;

/** Sidecar lifecycle snapshot pushed by the supervisor (desktop-app §4.3). */
export interface GatewaySnapshot {
  state: 'running' | 'stopped' | 'error';
  pid?: number;
  startedAt?: number;
  rpcUrl?: string;
  /** Version the running gateway reported in its PID record (§4.5). */
  version?: string;
  /** Crash reason — tail of gateway.log — when `state === 'error'`. */
  detail?: string;
  /** Config changed since boot ⇒ a restart applies it (§4.3). */
  stale: boolean;
  /** A start/restart is in flight (until /rpc is back). Chat shows "重启中". */
  restarting: boolean;
  /** 'fused' after `crashLoopLimit` consecutive crashes — no more auto-restarts
   *  until a manual start/restart (§4.3). */
  autoRestart: 'armed' | 'fused';
  /** Consecutive crash count feeding the fuse. */
  crashCount: number;
  /** Version shipped inside this app build (resources/sidecar/version.json). */
  bundledVersion?: string;
  /** Running version ≠ bundled version ⇒ prompt "重启以升级" (§4.5). */
  versionMismatch: boolean;
}

/** App-server connection state pushed by the connection manager (§7). */
export interface RpcState {
  phase: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'gateway-restarting' | 'error';
  accountId?: string;
  url?: string;
  error?: string;
  /** JSON-RPC error code when `phase === 'error'` (e.g. -32002 → re-enter key). */
  errorCode?: number;
}

export type ThemeSetting = 'light' | 'dark' | 'system';
export type LanguageSetting = 'zh' | 'en' | 'system';

export interface AppSettings {
  /** Stop the local gateway when the app quits (default false — it stays resident, §4.4). */
  stopGatewayOnQuit: boolean;
  /** UI theme; 'system' follows the OS (default). Main applies it via nativeTheme,
   *  so the renderer's prefers-color-scheme and the window chrome both follow. */
  theme: ThemeSetting;
  /** UI language; 'system' follows the OS locale (default). */
  language: LanguageSetting;
}

/** Auto-update state pushed by the updater (§8.2). */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'downloaded' | 'error';
  version?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Embedded browser (desktop-app §browser). The web content is a native
// WebContentsView the main process composites over the window; the renderer
// draws only the chrome and reports where the content region should paint.
// ---------------------------------------------------------------------------

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserState {
  tabs: BrowserTab[];
  activeTabId?: string;
}

/** Content-region bounds (DIP) the renderer measures for the native view. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One row in the floating browser-activity overlay (native view). */
export interface OverlayItem {
  name: string;
  detail?: string;
  status: 'running' | 'done' | 'error';
}

// ---------------------------------------------------------------------------
// Standalone artifact preview window (desktop-app §artifacts). Unlike the
// embedded browser this is plain renderer DOM (react-markdown / iframe), so it
// carries the artifact bytes over IPC: the MAIN app window fetches them over RPC
// and pushes this state through main to the preview window, which stays purely
// presentational (no session/rpc bridge — only settings for i18n/theme).
// ---------------------------------------------------------------------------

export interface ArtifactWindowState {
  artifact?: Artifact;
  /** Owning session + profile — let the window trigger a chunked download for
   *  "open" (requests route by profile, multi-gateway §7). */
  sessionId?: string;
  profileId?: string;
  /** Absolute on-disk path when the session is local — enables "open in OS app". */
  absPath?: string;
  /** Base64 file bytes; present once `status === 'ready'`. */
  base64?: string;
  /** The file exceeded the RPC read cap and was clipped (source view only). */
  truncated?: boolean;
  status: 'empty' | 'loading' | 'ready' | 'error';
}
