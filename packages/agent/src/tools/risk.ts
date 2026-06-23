/**
 * Static risk tier per built-in local tool (agent §3.8.2). Single source for the
 * plan-mode read-only gate (and, later, the auto-mode classifier). Tools not
 * listed default to 'exec' — treated as high-risk / fully gated.
 */
import type { RiskTier } from '@enterprise-agent/agent-contract';

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
 * so both `gate.ts` (dangerous-grant stripping) and `bypass-policy.ts`
 * (bypass-mode high-risk gate) can share it without a circular import.
 */
export const DANGEROUS_AUTO_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'node', 'deno', 'bun', 'python', 'python3',
  'ruby', 'perl', 'php', 'eval', 'exec', 'sudo', 'doas', 'su', 'powershell', 'pwsh',
]);
