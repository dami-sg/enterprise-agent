/**
 * Config-panel manager (desktop-app §6.1): runs the existing Web panel
 * (`ea-gateway ui`) as a child of the app — same UI, same on-disk truth — and
 * logs the desktop in WITHOUT weakening auth: the admin cookie is deterministic
 * (`sha256(secret + '|ea-admin')`, admin-auth.ts), so the main process computes
 * it from the shared 0600 secret file and injects it into the Electron session.
 * `--no-autostart` keeps data-plane lifecycle single-ownered by the supervisor.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ADMIN_COOKIE, adminCookieValue } from '@dami-sg/gateway/admin-auth';
import { createGatewayPaths } from '@dami-sg/gateway/paths';

export interface PanelOptions {
  sidecarBin: string;
  root?: string;
  port?: number;
  log?: (line: string) => void;
  /** Inject the admin cookie into the browser session (Electron `session.cookies`). */
  setCookie: (opts: { url: string; name: string; value: string }) => Promise<void>;
}

export interface PanelHandle {
  url: string;
  dispose(): void;
}

const DEFAULT_PORT = 7317;

export class PanelManager {
  private child?: ChildProcess;
  private url?: string;
  private starting?: Promise<string>;

  constructor(private readonly opts: PanelOptions) {}

  /** Ensure a panel is up and the admin cookie is set; returns its URL.
   *  Reuses an already-listening panel (e.g. the operator's own `ea-gateway ui`). */
  ensure(): Promise<string> {
    this.starting ??= this.doEnsure().catch((err) => {
      this.starting = undefined;
      throw err;
    });
    return this.starting;
  }

  private async doEnsure(): Promise<string> {
    const port = this.opts.port ?? DEFAULT_PORT;
    const url = `http://127.0.0.1:${port}`;
    const log = this.opts.log ?? (() => {});

    if (!(await panelResponds(url))) {
      log(`[panel] 启动配置面板：${url}`);
      const args = [this.opts.sidecarBin, 'ui', '--no-autostart', '--port', String(port)];
      if (this.opts.root) args.push('--root', this.opts.root);
      this.child = spawn(process.execPath, args, {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
      });
      this.child.on('exit', (code) => {
        log(`[panel] 面板进程退出（code ${code ?? '?'}）`);
        this.child = undefined;
        this.starting = undefined;
      });
      await waitFor(() => panelResponds(url), 10_000, 250);
    } else {
      log(`[panel] 复用已在运行的面板：${url}`);
    }

    await this.injectAdminCookie(url);
    this.url = url;
    return url;
  }

  /** Compute the stateless admin cookie from the shared secret file (§6.1). */
  private async injectAdminCookie(url: string): Promise<void> {
    const paths = createGatewayPaths(this.opts.root);
    let secret: string | undefined;
    try {
      secret = readFileSync(paths.adminSecret, 'utf8').trim() || undefined;
    } catch {
      /* not created yet — panel will render its login; the sidecar creates it on boot */
    }
    if (!secret) return;
    await this.opts.setCookie({ url, name: ADMIN_COOKIE, value: adminCookieValue(secret) });
  }

  currentUrl(): string | undefined {
    return this.url;
  }

  /** Admin cookie value for server-side API calls (admin bridge, §6.2). */
  adminCookieHeader(): string | undefined {
    const paths = createGatewayPaths(this.opts.root);
    try {
      const secret = readFileSync(paths.adminSecret, 'utf8').trim();
      if (!secret) return undefined;
      return `${ADMIN_COOKIE}=${adminCookieValue(secret)}`;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    // The panel is a UI child (unlike the detached data plane) — it dies with the app.
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.starting = undefined;
  }
}

async function panelResponds(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/admin/me`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(probe: () => Promise<boolean>, timeoutMs: number, stepMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('配置面板启动超时');
}
