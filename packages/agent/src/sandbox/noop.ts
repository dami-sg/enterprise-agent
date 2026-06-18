/**
 * Pass-through sandbox (agent §4.1 "sandbox off"): falls back to pure
 * application-layer gating (JS path checks + three-state approval still apply).
 */
import type { Sandbox, SandboxContext, SandboxPolicy, SpawnSpec } from './sandbox.js';

export class NoopSandbox implements Sandbox {
  readonly enabled = false;

  buildPolicy(ctx: SandboxContext): SandboxPolicy {
    return {
      allowWrite: ctx.rootPaths,
      network: ctx.allowHosts && ctx.allowHosts.length
        ? { mode: 'allowlist', hosts: ctx.allowHosts }
        : { mode: 'allow' },
    };
  }

  wrapCommand(cmd: string, args: string[]): SpawnSpec {
    return { command: cmd, args };
  }

  parseTrap(): null {
    return null;
  }
}
