/**
 * OS-level sandbox abstraction (agent §4.1). The backend is replaceable;
 * `LandstripSandbox` is the first implementation. Policy is an Anthropic
 * Sandbox Runtime JSON subset derived from the session boundary.
 */

export interface SandboxPolicy {
  /** Writable roots: Work → workspace.rootPath; Chat → private scratch/. */
  allowWrite: string[];
  /** Readable roots (defaults to allowWrite + system read paths). */
  allowRead?: string[];
  network:
    | { mode: 'deny' }
    | { mode: 'allow' }
    | { mode: 'allowlist'; hosts: string[] };
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Extra env to inject (e.g. policy file path). */
  env?: Record<string, string>;
}

export interface SandboxDenial {
  kind: 'write' | 'read' | 'network';
  path?: string;
  host?: string;
  /** Grant to merge into the policy on "approve for task" (agent §4.1). */
  suggestedGrant: Partial<SandboxPolicy>;
}

/** Context needed to build a policy (subset of WorkspaceContext, agent §2.5). */
export interface SandboxContext {
  rootPaths: string[];
  allowHosts?: string[];
}

export interface Sandbox {
  readonly enabled: boolean;
  buildPolicy(ctx: SandboxContext): SandboxPolicy;
  wrapCommand(cmd: string, args: string[], policy: SandboxPolicy): SpawnSpec;
  parseTrap(line: string): SandboxDenial | null;
}

/** Merge a suggested grant into an existing policy (approval closure). */
export function mergeGrant(policy: SandboxPolicy, grant: Partial<SandboxPolicy>): SandboxPolicy {
  const next: SandboxPolicy = {
    allowWrite: [...new Set([...policy.allowWrite, ...(grant.allowWrite ?? [])])],
    allowRead: grant.allowRead
      ? [...new Set([...(policy.allowRead ?? []), ...grant.allowRead])]
      : policy.allowRead,
    network: grant.network ?? policy.network,
  };
  return next;
}
