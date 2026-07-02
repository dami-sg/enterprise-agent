/**
 * `full` execution-mode policy (agent §3.8.5). In full mode the model classifier
 * is skipped AND the workspace boundary guardrail is off (see docs/full-mode.md):
 * the gate prompts for human approval ONLY on the two narrowest catastrophic
 * categories —
 *   1. privilege escalation (sudo / doas / su / pkexec), and
 *   2. high-risk destructive deletion (rm/-style deletes whose target is `/`, the
 *      home dir, a broad glob, or a system directory).
 *
 * Everything else runs unprompted, INCLUDING interpreters (`bash -c`, `python`,
 * `node -e`), disk tools (`dd`, `mkfs`), network listeners (`nc -l`), and
 * `runScript`. This is a deliberate, broad safety relaxation chosen by the
 * operator — see docs/full-mode.md for the (large) residual risk surface.
 */
import { isAbsolute, resolve } from 'node:path';
import type { GatedToolCall } from './gate.js';
import { normalizeExecutable } from './risk.js';

/** runCommand input shape (see exec.ts). */
interface RunCommandInput {
  command: string;
  args?: string[];
}

/** Privilege-escalation shims — always gated in full mode. */
const PRIVILEGE_ESCALATION = new Set(['sudo', 'doas', 'su', 'pkexec', 'runas']);
/** Deletion executables. */
const DELETE_EXES = new Set(['rm', 'rmdir', 'unlink', 'srm']);
/** Top-level system directories whose deletion is catastrophic. Excludes
 *  user-area roots (/home, /Users) where workspaces normally live. */
const SYSTEM_PREFIXES = [
  '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/dev', '/sys', '/proc', '/var', '/root', '/System', '/Library',
];

/**
 * Whether a tool call still needs human approval in full mode. Returns `true`
 * ONLY for privilege escalation and high-risk destructive deletion; every other
 * call (returning `false`) is auto-allowed — the workspace boundary is NOT
 * consulted here (it is disabled in full mode).
 */
export function requiresApprovalInFull(call: GatedToolCall): boolean {
  if (call.toolName !== 'runCommand') return false; // runScript / file tools / httpFetch → allowed
  const { command, args = [] } = (call.input ?? {}) as RunCommandInput;
  if (typeof command !== 'string') return false;
  const exe = normalizeExecutable(command);

  // 1) Privilege escalation.
  if (PRIVILEGE_ESCALATION.has(exe)) return true;

  // 2) High-risk destructive deletion: a delete whose target is the filesystem
  //    root, the home dir, a broad glob, or a system directory. A specific path
  //    (in- or out-of-workspace) is NOT gated — the boundary guardrail is off.
  const isDelete =
    DELETE_EXES.has(exe) ||
    (exe === 'find' && args.includes('-delete')) ||
    (exe === 'git' && args[0] === 'clean' && /-[a-z]*f/.test(args.join(' ')));
  if (isDelete && args.filter((a) => !a.startsWith('-')).some(isDangerousDeleteTarget)) return true;

  return false; // everything else → full-mode-allowed
}

/**
 * Whether a delete target is catastrophic regardless of the workspace: a root or
 * home symbol (`/`, `~`, `~/…`, `$HOME`), a broad glob (`*`, `.*`, `/*`), or a
 * path under a known system directory. Specific non-system paths return `false`.
 */
function isDangerousDeleteTarget(t: string): boolean {
  if (t === '/' || t === '~' || t.startsWith('~/') || /\$\{?HOME\b/.test(t)) return true;
  if (/(^|\/)\*|^\.\*/.test(t)) return true; // broad glob
  if (isAbsolute(t)) {
    const abs = resolve(t);
    if (abs === '/') return true;
    if (SYSTEM_PREFIXES.some((p) => abs === p || abs.startsWith(p + '/'))) return true;
  }
  return false;
}
