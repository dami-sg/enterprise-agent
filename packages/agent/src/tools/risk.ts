/**
 * Static risk tier per built-in local tool (agent §3.8.2). Single source for the
 * plan-mode read-only gate (and, later, the auto-mode classifier). Tools not
 * listed default to 'exec' — treated as high-risk / fully gated.
 */
import { basename } from 'node:path';
import type { RiskTier } from '@dami-sg/agent-contract';

/**
 * Canonical executable name used for EVERY policy/interpreter check (agent §3.8.5).
 * The command is spawned via `$PATH`, so `rm`, `/bin/rm`, `RM`, and `rm ` (trailing
 * space) all invoke the same binary; matching allow/deny/dangerous sets against the
 * raw string is trivially bypassed. Reduce to the lowercased basename (dropping any
 * directory prefix and surrounding whitespace) so `/bin/bash` matches `bash`. Shared
 * by exec.ts (deny/allow/dangerous), gate.ts (grant key), and full-mode-policy.ts.
 */
export function normalizeExecutable(command: string): string {
  return basename(command.trim()).toLowerCase();
}

export const TOOL_RISK: Record<string, RiskTier> = {
  // read-only + side-effect-free meta tools — always allowed, even in plan mode
  readFile: 'readonly',
  listDir: 'readonly',
  search: 'readonly',
  getCurrentTime: 'readonly',
  useSkill: 'readonly',
  searchSkills: 'readonly',
  updateTodos: 'readonly',
  askUserQuestion: 'readonly',
  exitPlanMode: 'readonly',
  // mutating
  writeFile: 'write',
  applyPatch: 'write',
  runCommand: 'exec',
  runScript: 'exec',
  httpFetch: 'network',
};

export function toolRisk(toolName: string): RiskTier {
  return TOOL_RISK[toolName] ?? 'exec';
}

/**
 * Command interpreters + privilege-escalation shims whose grant must NOT
 * auto-allow in auto mode (agent §3.8.5): a bare interpreter would let the
 * classifier be bypassed (`bash -c "rm -rf"`), and a prior `bash` grant must
 * not become a blanket "run any bash" permission. Lives here (a leaf module)
 * so both `gate.ts` (dangerous-grant stripping) and `full-mode-policy.ts`
 * (full-mode high-risk gate) can share it without a circular import.
 */
export const DANGEROUS_AUTO_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'node', 'deno', 'bun', 'python', 'python3',
  'ruby', 'perl', 'php', 'eval', 'exec', 'sudo', 'doas', 'su', 'powershell', 'pwsh',
]);
