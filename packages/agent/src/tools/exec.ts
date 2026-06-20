/**
 * Execution tools (agent §3.1, high risk → default approval). Commands run
 * wrapped by the OS sandbox (agent §4.1); a sandbox denial (trap) yields a
 * `suggested_grant` that feeds the three-state approval closure and retries.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunContext } from '../runtime/context.js';
import { gated, ToolRejectedError } from './gate.js';
import { guardPath, PathBoundaryError } from './path-guard.js';
import { mergeGrant, type SandboxDenial } from '../sandbox/sandbox.js';

const DEFAULT_TIMEOUT_MS = 120_000;

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  denials: SandboxDenial[];
  command: string;
}

export function buildExecTools(ctx: RunContext) {
  const { sandbox, permission } = ctx.shared;

  async function runOnce(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
    const spec = sandbox.wrapCommand(cmd, args, ctx.shared.sandboxPolicy);
    return new Promise<ExecResult>((resolveP) => {
      const child = spawn(spec.command, spec.args, {
        cwd,
        env: { ...process.env, ...spec.env },
        signal: ctx.abortSignal,
      });
      // Feed the sandbox policy (or nothing) on stdin, then close it so tools
      // that don't read stdin don't block waiting on it. Swallow EPIPE if the
      // child died before reading (e.g. spawn failure).
      child.stdin?.on('error', () => {});
      if (spec.stdin !== undefined) child.stdin?.write(spec.stdin);
      child.stdin?.end();
      let stdout = '';
      let stderr = '';
      const denials: SandboxDenial[] = [];
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => {
        const text = d.toString();
        stderr += text;
        for (const line of text.split('\n')) {
          const trap = sandbox.parseTrap(line);
          if (trap) denials.push(trap);
        }
      });
      child.on('error', (err) => {
        resolveP({ stdout, stderr: stderr + String(err), exitCode: null, denials, command: `${cmd} ${args.join(' ')}` });
      });
      child.on('close', (code) => {
        resolveP({ stdout, stderr, exitCode: code, denials, command: `${cmd} ${args.join(' ')}` });
      });
    });
  }

  function checkPolicy(executable: string): string | undefined {
    if (permission.denyCommands?.includes(executable)) {
      return `command '${executable}' is denied by policy`;
    }
    return undefined;
  }

  /**
   * Confine the working directory to the session boundary (agent §4): an
   * unguarded `cwd` would let a command run anywhere on disk when the OS sandbox
   * is off (NoopSandbox). Mirrors the file tools' guardPath check.
   */
  function resolveCwd(cwd: string | undefined): string {
    return cwd ? guardPath(cwd, ctx.shared.rootPaths) : ctx.shared.rootPaths[0]!;
  }

  const runCommand = tool({
    description:
      'Run a command: an executable plus args, e.g. `git status`, `pnpm test`, or `python3 script.py`. ' +
      'To execute code you generated, first write it with writeFile, then run it here (or use `bash -c "…"` / `python3 -c "…"` for a one-liner). ' +
      'High risk: requires approval unless granted for the task. Sandboxed when enabled.',
    inputSchema: z.object({
      command: z.string().describe('Executable name, e.g. "git" or "python3".'),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    }),
    execute: async ({ command, args = [], cwd }, { toolCallId }) => {
      const denied = checkPolicy(command);
      if (denied) {
        ctx.shared.audit.record({
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId,
          tool: 'runCommand',
          input: { command, args },
          approval: 'denied-policy',
          grantKey: command,
        });
        return { error: denied };
      }
      let cwdAbs: string;
      try {
        cwdAbs = resolveCwd(cwd);
      } catch (e) {
        if (e instanceof PathBoundaryError) return { error: 'cwd_outside_boundary', cwd };
        throw e;
      }
      // Grant key = executable name (argv[0]); auto-allow `git *` for the task.
      const autoAllowed = permission.allowCommands?.includes(command);
      const exec = () => runWithClosure(command, args, cwdAbs);
      if (autoAllowed) {
        // Policy-allowlisted: skips approval but is still audited (agent §5.2).
        const output = await exec();
        ctx.shared.audit.record({
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId,
          tool: 'runCommand',
          input: { command, args },
          output,
          approval: 'auto',
          grantKey: command,
        });
        return output;
      }
      try {
        return await gated(
          ctx,
          {
            toolName: 'runCommand',
            toolCallId,
            input: { command, args },
            grantKey: command,
            grantScope: `run \`${command} *\` for this task`,
          },
          exec,
        );
      } catch (e) {
        if (e instanceof ToolRejectedError) return { error: 'rejected' };
        throw e;
      }
    },
  });

  const runScript = tool({
    description:
      'Write a script to a temp file and execute it with the given interpreter. High risk: requires approval.',
    inputSchema: z.object({
      interpreter: z.enum(['bash', 'sh', 'node', 'python3']),
      script: z.string(),
      cwd: z.string().optional(),
    }),
    execute: async ({ interpreter, script, cwd }, { toolCallId }) => {
      let cwdAbs: string;
      try {
        cwdAbs = resolveCwd(cwd);
      } catch (e) {
        if (e instanceof PathBoundaryError) return { error: 'cwd_outside_boundary', cwd };
        throw e;
      }
      try {
        return await gated(
          ctx,
          {
            toolName: 'runScript',
            toolCallId,
            input: { interpreter, length: script.length },
            grantKey: interpreter,
            grantScope: `run ${interpreter} scripts for this task`,
          },
          async () => {
            const dir = mkdtempSync(join(tmpdir(), 'zt-script-'));
            try {
              const ext = interpreter === 'node' ? 'js' : interpreter === 'python3' ? 'py' : 'sh';
              const file = join(dir, `script.${ext}`);
              writeFileSync(file, script, 'utf8');
              return await runWithClosure(interpreter, [file], cwdAbs);
            } finally {
              // Don't leak the temp script dir, regardless of how the run ends.
              rmSync(dir, { recursive: true, force: true });
            }
          },
        );
      } catch (e) {
        if (e instanceof ToolRejectedError) return { error: 'rejected' };
        throw e;
      }
    },
  });

  /** Run, and on a sandbox denial request a grant + retry once (agent §4.1). */
  async function runWithClosure(cmd: string, args: string[], cwd: string) {
    let res = await runOnce(cmd, args, cwd);
    if (res.denials.length > 0 && sandbox.enabled) {
      const grant = res.denials[0]!;
      const key = grant.path ?? grant.host ?? 'sandbox';
      const result = await ctx.shared.approval.gate({
        runId: ctx.runId,
        toolName: 'sandboxGrant',
        toolCallId: `sandbox-${key}`,
        agentId: ctx.agentId,
        parentAgentId: ctx.parentAgentId,
        input: grant,
        grantKey: key,
        grantScope: `extend sandbox: ${JSON.stringify(grant.suggestedGrant)}`,
      });
      // Audit the policy-extension decision: it is the highest-privilege approval
      // a command can trigger, so it must be retraceable like every other (§5.2).
      ctx.shared.audit.record({
        runId: ctx.runId,
        agentId: ctx.agentId,
        toolCallId: `sandbox-${key}`,
        tool: 'sandboxGrant',
        input: grant,
        approval: result.mode,
        grantKey: key,
      });
      if (result.mode !== 'reject') {
        ctx.shared.sandboxPolicy = mergeGrant(ctx.shared.sandboxPolicy, grant.suggestedGrant);
        res = await runOnce(cmd, args, cwd);
      }
    }
    return {
      command: res.command,
      exitCode: res.exitCode,
      stdout: res.stdout.slice(0, 16_000),
      stderr: res.stderr.slice(0, 8_000),
      denied: res.denials.length > 0,
    };
  }

  return { runCommand, runScript };
}
