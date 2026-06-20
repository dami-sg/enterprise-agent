/**
 * Non-interactive approval policy (cli §6.2 / §11.3). In a script there is no
 * one to press a key, so `ea run` must declare upfront how to answer
 * `tool-approval-required`. The safe default is `reject`: automatic approval is
 * always an explicit, opt-in downgrade (the sandbox + audit still apply — only
 * the human click is skipped, agent §3.3 / §4.1).
 */
import type {
  ApprovalDecision,
  PermissionPolicy,
} from '@enterprise-agent/agent-contract';
import { readFileSync } from 'node:fs';

export type ApprovePolicy =
  | { mode: 'reject' }
  | { mode: 'auto'; decision: 'once' | 'session' }
  | { mode: 'policy'; policy: PermissionPolicy };

export interface ApprovalRequest {
  toolName: string;
  grantScope?: string;
  input: unknown;
}

/** Parse a `--approve` spec: `reject` | `auto:once` | `auto:session` | `policy:<file>`. */
export function parseApprovePolicy(spec: string | undefined): ApprovePolicy {
  if (!spec || spec === 'reject') return { mode: 'reject' };
  if (spec === 'auto:once') return { mode: 'auto', decision: 'once' };
  if (spec === 'auto:session' || spec === 'auto:task') return { mode: 'auto', decision: 'session' };
  if (spec.startsWith('policy:')) {
    const file = spec.slice('policy:'.length);
    const policy = JSON.parse(readFileSync(file, 'utf8')) as PermissionPolicy;
    return { mode: 'policy', policy };
  }
  throw new Error(`unknown --approve policy: ${spec} (use reject | auto:once | auto:session | policy:<file>)`);
}

/** Resolve an approval request to a decision under the chosen policy. */
export function decide(policy: ApprovePolicy, req: ApprovalRequest): ApprovalDecision {
  switch (policy.mode) {
    case 'reject':
      return 'reject';
    case 'auto':
      return policy.decision;
    case 'policy':
      return matchPolicy(policy.policy, req);
  }
}

function matchPolicy(policy: PermissionPolicy, req: ApprovalRequest): ApprovalDecision {
  const argv0 = commandArgv0(req);
  if (argv0 && policy.denyCommands?.includes(argv0)) return 'reject';
  if (policy.requireApproval?.includes(req.toolName)) return 'reject';
  if (argv0 && policy.allowCommands?.includes(argv0)) return 'session';
  // Unmatched → safe default (cli §6.2 "未匹配落回 reject").
  return 'reject';
}

function commandArgv0(req: ApprovalRequest): string | undefined {
  if (req.toolName !== 'runCommand' || req.input == null || typeof req.input !== 'object') return undefined;
  const o = req.input as Record<string, unknown>;
  if (typeof o['command'] === 'string') return o['command'].trim().split(/\s+/)[0];
  if (Array.isArray(o['args']) && typeof o['args'][0] === 'string') return o['args'][0];
  return undefined;
}
