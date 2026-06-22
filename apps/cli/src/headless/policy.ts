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
import { resolve, sep } from 'node:path';

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
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`--approve policy file not found or unreadable: ${file}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`--approve policy file is not valid JSON (${file}): ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`--approve policy file must be a PermissionPolicy object (${file})`);
    }
    return { mode: 'policy', policy: parsed as PermissionPolicy };
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

/**
 * Resolve a gated tool call against a `PermissionPolicy` (cli §6.2). Matches by
 * the policy field relevant to each tool category — commands by argv[0]
 * (`allow/denyCommands`), network by host (`allowHosts`), and write tools by
 * target path (`allowPaths`) — so a CI policy file can auto-approve more than
 * just commands. `requireApproval` and any unmatched call fall back to reject
 * (no human is present to confirm).
 */
function matchPolicy(policy: PermissionPolicy, req: ApprovalRequest): ApprovalDecision {
  // Explicitly "always ask a human" → there's no human here, so reject.
  if (policy.requireApproval?.includes(req.toolName)) return 'reject';

  // Commands: deny wins, then allowlist by executable (argv[0]).
  const argv0 = commandArgv0(req);
  if (argv0) {
    if (policy.denyCommands?.includes(argv0)) return 'reject';
    if (policy.allowCommands?.includes(argv0)) return 'session';
    return 'reject';
  }

  // Network: auto-allow when the target host is on the allowlist.
  if (req.toolName === 'httpFetch') {
    const host = requestHost(req);
    if (host && policy.allowHosts?.includes(host)) return 'session';
    return 'reject';
  }

  // Write tools: auto-allow when the (boundary-resolved, absolute) target path
  // sits under one of the allowed prefixes.
  if (req.toolName === 'writeFile' || req.toolName === 'applyPatch') {
    const path = requestPath(req);
    if (path && policy.allowPaths?.some((root) => withinPath(path, root))) return 'session';
    return 'reject';
  }

  // Unmatched (e.g. MCP tools, which the policy schema can't express) → reject.
  return 'reject';
}

function commandArgv0(req: ApprovalRequest): string | undefined {
  if (req.toolName !== 'runCommand' || req.input == null || typeof req.input !== 'object') return undefined;
  const o = req.input as Record<string, unknown>;
  // argv0 is the executable only — never fall back to an argument (`args[0]`),
  // which would allowlist-match a command argument and fail open.
  if (typeof o['command'] === 'string') return o['command'].trim().split(/\s+/)[0];
  return undefined;
}

/** The request host for `httpFetch` (from its `url` input), if parseable. */
function requestHost(req: ApprovalRequest): string | undefined {
  if (req.input == null || typeof req.input !== 'object') return undefined;
  const url = (req.input as Record<string, unknown>)['url'];
  if (typeof url !== 'string') return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The absolute target path for a write tool (`writeFile`/`applyPatch`). */
function requestPath(req: ApprovalRequest): string | undefined {
  if (req.input == null || typeof req.input !== 'object') return undefined;
  const path = (req.input as Record<string, unknown>)['path'];
  return typeof path === 'string' ? path : undefined;
}

/**
 * Whether `child` is `root` or sits beneath it (separator-aware prefix check).
 * Both sides are resolved first so the decision can't be fooled by `..` or a
 * non-normalized root — defense-in-depth, independent of upstream normalization.
 */
function withinPath(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  if (c === r) return true;
  return c.startsWith(r.endsWith(sep) ? r : r + sep);
}
