/**
 * First sandbox backend (agent §4.1): wraps commands with the `landstrip` CLI
 * (macOS Seatbelt / Linux Landlock+seccomp / Windows AppContainer), pinned by
 * the managed install (sandbox/install.ts). This class translates our internal
 * policy into landstrip's Anthropic-Sandbox-Runtime JSON and parses its traps.
 *
 * Invocation matches landstrip 0.15.17's real CLI: `landstrip -- <tool> <args>`
 * with the policy JSON fed on **stdin** (landstrip reads stdin when `-p` is
 * omitted). Denials are printed to **stderr as one JSON object per line**; the
 * `filesystem`/`network` ones carry a `suggested_grant` that feeds the
 * three-state approval closure (§3.3). On macOS (Seatbelt) a denial may instead
 * surface as a plain EPERM from the tool, with no JSON trap.
 */
import { spawnSync } from 'node:child_process';
import type {
  Sandbox,
  SandboxContext,
  SandboxDenial,
  SandboxPolicy,
  SpawnSpec,
} from './sandbox.js';

export interface LandstripOptions {
  /** Path/name of the landstrip executable (locked version, agent §4.1). */
  bin?: string;
  /** Platform override (for tests); defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export class LandstripSandbox implements Sandbox {
  readonly enabled = true;
  private readonly bin: string;
  private readonly platform: NodeJS.Platform;

  constructor(opts: LandstripOptions = {}) {
    this.bin = opts.bin ?? 'landstrip';
    this.platform = opts.platform ?? process.platform;
  }

  /**
   * Whether the `landstrip` executable is actually installed (agent §4.1). The
   * sandbox wraps every command with this binary; if it's missing, commands
   * would fail with ENOENT, so the host probes this before enabling the sandbox
   * and falls back to no-sandbox with a warning rather than breaking execution.
   */
  static isAvailable(bin = 'landstrip'): boolean {
    try {
      const res = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 3_000 });
      // ENOENT (not on PATH) → unavailable; any other outcome means it ran.
      return !(res.error && (res.error as NodeJS.ErrnoException).code === 'ENOENT');
    } catch {
      return false;
    }
  }

  buildPolicy(ctx: SandboxContext): SandboxPolicy {
    // landstrip network is coarse (allow-all / deny-all). Open by default so
    // network tools work; deny only when explicitly disabled (agent §4.1). The
    // host's `allowHosts` allowlist is enforced app-side (httpFetch/MCP), not here.
    const network: SandboxPolicy['network'] = ctx.allowNetwork === false ? { mode: 'deny' } : { mode: 'allow' };
    return { allowWrite: ctx.rootPaths, allowRead: ctx.rootPaths, network };
  }

  wrapCommand(cmd: string, args: string[], policy: SandboxPolicy): SpawnSpec {
    // `landstrip -- <tool> <args>`, policy as Anthropic-Sandbox-Runtime JSON on
    // stdin (landstrip reads stdin when `-p` is omitted). `--` guards tool args
    // that begin with `-` from being parsed as landstrip options.
    return {
      command: this.bin,
      args: ['--', cmd, ...args],
      stdin: JSON.stringify(toLandstripPolicy(policy)),
    };
  }

  parseTrap(line: string): SandboxDenial | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return null; // not a landstrip JSON trap line
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return null;
    }
    // Only filesystem / network denials are grantable; launch/internal are real
    // errors that should surface, not trigger an approval-extension closure.
    if (json.kind !== 'filesystem' && json.kind !== 'network') return null;
    const op = json.operation === 'read' ? 'read' : json.kind === 'network' ? 'network' : 'write';
    return {
      kind: op,
      path: typeof json.path === 'string' ? json.path : undefined,
      host: typeof json.target === 'string' ? json.target : undefined,
      suggestedGrant: normalizeGrant((json.suggested_grant as Record<string, unknown>) ?? {}),
    };
  }
}

/** Translate our internal policy into landstrip's Anthropic-Sandbox-Runtime JSON. */
function toLandstripPolicy(policy: SandboxPolicy): Record<string, unknown> {
  return {
    filesystem: {
      allowWrite: policy.allowWrite,
      allowRead: policy.allowRead ?? policy.allowWrite,
    },
    // landstrip network is coarse (allow-all / deny-all): any non-deny mode →
    // grant network; default (deny) leaves enforcement on (agent §4.1).
    network: { allowNetwork: policy.network.mode !== 'deny' },
  };
}

/** Map a landstrip `suggested_grant` (paths as string or string[]) into our policy. */
function normalizeGrant(raw: Record<string, unknown>): Partial<SandboxPolicy> {
  const grant: Partial<SandboxPolicy> = {};
  const toArr = (v: unknown): string[] | undefined =>
    typeof v === 'string' ? [v] : Array.isArray(v) ? (v as string[]) : undefined;
  const aw = toArr(raw.allowWrite);
  const ar = toArr(raw.allowRead);
  if (aw) grant.allowWrite = aw;
  if (ar) grant.allowRead = ar;
  // A network suggestion (allowNetwork) → open network (coarse, agent §4.1).
  if (raw.allowNetwork === true || (raw.network as { allowNetwork?: unknown })?.allowNetwork === true) {
    grant.network = { mode: 'allow' };
  }
  return grant;
}
