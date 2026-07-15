/**
 * Sidecar location + process-manager factory (desktop-app §4.2). The gateway
 * bundle lives in `resources/sidecar/` (dev tree and packaged app alike —
 * electron-builder ships it via extraResources). The manager's injection seams
 * carry the Electron specifics: exec = the Electron binary itself, run as plain
 * Node via `ELECTRON_RUN_AS_NODE=1` — no second Node runtime is shipped.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GatewayProcessManager } from '@dami-sg/gateway/process';
import { createGatewayPaths } from '@dami-sg/gateway/paths';

export interface SidecarInfo {
  /** Absolute path to gateway.mjs. */
  bin: string;
  /** Version shipped with this app build (version.json), for §4.5. */
  bundledVersion?: string;
  dir: string;
}

export function resolveSidecar(opts: { isPackaged: boolean; resourcesPath: string; appPath: string }): SidecarInfo {
  const dir = opts.isPackaged
    ? join(opts.resourcesPath, 'sidecar')
    : join(opts.appPath, 'resources', 'sidecar');
  const bin = join(dir, 'gateway.mjs');
  let bundledVersion: string | undefined;
  try {
    const raw = readFileSync(join(dir, 'version.json'), 'utf8');
    bundledVersion = (JSON.parse(raw) as { version?: string }).version;
  } catch {
    /* absent in odd dev states — the §4.5 banner simply stays off */
  }
  return { bin, bundledVersion, dir };
}

export function sidecarExists(info: SidecarInfo): boolean {
  return existsSync(info.bin);
}

/** A GatewayProcessManager driving the bundled sidecar for the given data root. */
export function createSidecarManager(info: SidecarInfo, root?: string, rpcPort?: number): GatewayProcessManager {
  return new GatewayProcessManager({
    paths: createGatewayPaths(root),
    root,
    exec: process.execPath, // the Electron binary
    bin: info.bin,
    extraArgs: rpcPort ? ['--rpc-port', String(rpcPort)] : [],
    spawn: (cmd, args, opts) =>
      nodeSpawn(cmd, args, {
        ...opts,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }),
  });
}
