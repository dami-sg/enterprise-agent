/**
 * First sandbox backend (agent §4.1): wraps commands with the `landstrip` CLI
 * (macOS Seatbelt / Linux Landlock+seccomp / Windows AppContainer). Version is
 * locked by the host install; this class only builds policy + parses traps.
 *
 * The policy is passed to the binary as `landstrip -p <policy.json> -- <cmd>`;
 * denials are emitted on stderr as `LANDSTRIP_TRAP {json}` lines carrying a
 * `suggested_grant`, which feeds the three-state approval closure (§3.3).
 */
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

  buildPolicy(ctx: SandboxContext): SandboxPolicy {
    // Windows network granularity is coarse (allow-all / deny-all) — agent §4.1.
    const coarseNetwork = this.platform === 'win32';
    const network: SandboxPolicy['network'] =
      ctx.allowHosts && ctx.allowHosts.length
        ? coarseNetwork
          ? { mode: 'allow' }
          : { mode: 'allowlist', hosts: ctx.allowHosts }
        : { mode: 'deny' };
    return { allowWrite: ctx.rootPaths, allowRead: ctx.rootPaths, network };
  }

  wrapCommand(cmd: string, args: string[], policy: SandboxPolicy): SpawnSpec {
    // Encode policy as base64 JSON in an env var the wrapper reads, avoiding a
    // temp file race; the locked landstrip build understands ENTERPRISE_AGENT_SANDBOX_POLICY.
    const policyB64 = Buffer.from(JSON.stringify(policy)).toString('base64');
    return {
      command: this.bin,
      args: ['--policy-env', 'ENTERPRISE_AGENT_SANDBOX_POLICY', '--', cmd, ...args],
      env: { ENTERPRISE_AGENT_SANDBOX_POLICY: policyB64 },
    };
  }

  parseTrap(line: string): SandboxDenial | null {
    const idx = line.indexOf('LANDSTRIP_TRAP ');
    if (idx === -1) return null;
    try {
      const json = JSON.parse(line.slice(idx + 'LANDSTRIP_TRAP '.length));
      const kind: SandboxDenial['kind'] = json.kind ?? 'write';
      return {
        kind,
        path: json.path,
        host: json.host,
        suggestedGrant: normalizeGrant(json.suggested_grant ?? json.suggestedGrant ?? {}),
      };
    } catch {
      return null;
    }
  }
}

function normalizeGrant(raw: Record<string, unknown>): Partial<SandboxPolicy> {
  const grant: Partial<SandboxPolicy> = {};
  if (typeof raw.allowWrite === 'string') grant.allowWrite = [raw.allowWrite];
  else if (Array.isArray(raw.allowWrite)) grant.allowWrite = raw.allowWrite as string[];
  if (typeof raw.allowRead === 'string') grant.allowRead = [raw.allowRead];
  else if (Array.isArray(raw.allowRead)) grant.allowRead = raw.allowRead as string[];
  if (raw.host && typeof raw.host === 'string') {
    grant.network = { mode: 'allowlist', hosts: [raw.host] };
  }
  return grant;
}
