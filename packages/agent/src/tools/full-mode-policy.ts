/**
 * `full` execution-mode policy (agent §3.8.5). In full mode the model classifier
 * is skipped: most tool calls run without asking, but an un-exemptible high-risk
 * set still routes to the human approval gate.
 *
 * The exemption is the classifier's ALWAYS-DENY set (auto-classifier.ts), reduced
 * to what a DETERMINISTIC rule can detect (since full mode runs no model): mass
 * deletion, privilege escalation, remote-code execution via any interpreter,
 * opening network listeners, disk-level destroyers, and any unvettable script.
 *
 * FAIL-CLOSED: anything we cannot positively determine is safe returns `true`
 * (must approve). Purely semantic dangers ("read a secret then send it out")
 * are NOT detectable here — see docs/full-mode.md for that residual risk.
 */
import { basename, isAbsolute, resolve } from 'node:path';
import type { GatedToolCall } from './gate.js';
import { DANGEROUS_AUTO_COMMANDS } from './risk.js';

/** runCommand input shape (see exec.ts). */
interface RunCommandInput {
  command: string;
  args?: string[];
}

/** Disk / filesystem destroyers — path-independent, always approve. */
const FS_DESTROYERS = /^(mkfs(\.\w+)?|dd|fdisk|parted|shred|wipefs|blkdiscard)$/;
/** Tools that open network listeners / build reverse shells. */
const LISTENERS = new Set(['nc', 'ncat', 'netcat', 'socat']);
/** Deletion executables. */
const DELETE_EXES = new Set(['rm', 'rmdir', 'unlink', 'srm']);

/**
 * Whether a tool call still needs human approval in full mode (= it hit the
 * un-exemptible high-risk set). Calls returning `false` are auto-allowed.
 *
 * @param roots the workspace roots (ctx.shared.rootPaths)
 */
export function requiresApprovalInFull(call: GatedToolCall, roots: string[]): boolean {
  // runScript executes an arbitrary script body we cannot vet statically.
  if (call.toolName === 'runScript') return true;
  // File tools are boundary-checked (guardPath) and can't escape the workspace;
  // httpFetch is allowed in full mode (egress residual risk — see the doc).
  if (call.toolName !== 'runCommand') return false;

  const { command, args = [] } = (call.input ?? {}) as RunCommandInput;
  if (typeof command !== 'string') return true; // malformed input → approve
  const exe = basename(command).toLowerCase();

  // 1) Any interpreter / privilege escalation (bash·sh·python·node·sudo·…):
  //    inline code (`bash -c`, `python -c`, `node -e`) and escalation are
  //    unvettable. Reuses the shared dangerous-command set.
  if (DANGEROUS_AUTO_COMMANDS.has(exe)) return true;

  // 2) Disk destroyers — always approve.
  if (FS_DESTROYERS.test(exe)) return true;

  // 3) Network listeners (`nc -l`, `ncat -l`, `socat …`).
  if (exe === 'socat') return true; // socat semantics too flexible → always approve
  if (LISTENERS.has(exe) && /(^|\s)-[a-z]*l/.test(args.join(' '))) return true;

  // 4) `git clean -f` deletes untracked files broadly (the subcommand is not a
  //    path, so the scope check below can't vet it) → always approve.
  if (exe === 'git' && args[0] === 'clean' && /-[a-z]*f/.test(args.join(' '))) return true;

  // 5) System-level destructive deletion: delete semantics whose target escapes
  //    the workspace or is a broad/root glob.
  const isDelete = DELETE_EXES.has(exe) || (exe === 'find' && args.includes('-delete'));
  if (isDelete && !isStrictlyInsideWorkspace(args, roots)) return true;

  return false; // everything else → full-mode-allowed
}

/**
 * Whether every delete target argument resolves strictly inside a workspace
 * root. Any of the following makes it unsafe (→ approve):
 *   - a root/home symbol or broad glob: bare `/`, `~`, `$HOME`, a `*` glob, `.*`
 *   - an absolute path under no root, or a relative path that `..`-escapes
 * An absolute path that DOES resolve under a root is fine (e.g. `/work/repo/x`).
 * FAIL-CLOSED: no recognizable path argument also counts as unsafe.
 */
function isStrictlyInsideWorkspace(args: string[], roots: string[]): boolean {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (targets.length === 0) return false; // flags only (e.g. shell-expanded `rm -rf *`) → approve
  const norm = roots.map((r) => resolve(r));
  for (const t of targets) {
    // root/home symbols and broad globs are never "inside" a specific root
    if (t === '/' || t === '~' || t.startsWith('~/') || /\$\{?HOME/.test(t) || /(^|\/)\*|^\.\*/.test(t)) {
      return false;
    }
    const abs = isAbsolute(t) ? resolve(t) : resolve(norm[0]!, t);
    if (!norm.some((r) => abs === r || abs.startsWith(r + '/'))) return false;
  }
  return true;
}
