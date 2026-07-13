/**
 * Headless single-run orchestrator (cli §5). Constructs nothing the TUI does
 * not — it shares the host and the event stream, swapping the renderer for a
 * printer (§5.3). Resolves the target session, drives one turn, applies the
 * non-interactive approval policy (§6.2), and maps the outcome to an exit code
 * (§5.4).
 */
import type { AgentStreamEvent } from '@dami-sg/agent-contract';
import type { CliContext } from '../host/bootstrap.js';
import { resolveWorkingDir } from '../host/resolve.js';
import { JsonRenderer, LineRenderer, type Renderer } from './render.js';
import { decide, parseApprovePolicy } from './policy.js';

export interface RunOptions {
  prompt: string;
  json?: boolean;
  quiet?: boolean;
  approve?: string;
  /** Continue an existing session by id; otherwise a fresh one is created. */
  session?: string;
  /** Name for an auto-created session (defaults to a prompt prefix). */
  title?: string;
  /** Bind the new session to a working directory (defaults to cwd). */
  cwd?: string;
}

/** Exit codes per cli §5.4 (130 = interrupted, the POSIX 128 + SIGINT). */
export const EXIT = { ok: 0, error: 1, rejected: 4, bootstrap: 5, interrupted: 130 } as const;

export async function runHeadless(ctx: CliContext, opts: RunOptions): Promise<number> {
  let policy: ReturnType<typeof parseApprovePolicy>;
  try {
    policy = parseApprovePolicy(opts.approve);
  } catch (err) {
    // A bad `--approve` spec / unreadable policy file is a config-init failure
    // (cli §5.4 → exit 5), not a run error.
    process.stderr.write(`ea: ${(err as Error).message}\n`);
    return EXIT.bootstrap;
  }
  const renderer: Renderer = opts.json ? new JsonRenderer() : new LineRenderer({ quiet: !!opts.quiet });

  // Resolve / create the session.
  let runId: string;
  if (opts.session) {
    ({ runId } = await ctx.host.sendMessage(opts.session, opts.prompt));
  } else {
    const started = await ctx.host.startSession({
      name: opts.title ?? deriveTitle(opts.prompt),
      workingDir: resolveWorkingDir(opts.cwd),
      goal: opts.prompt,
    });
    runId = started.runId;
  }

  let rejected = false;
  // The turn's run tree: the orchestrator run plus every sub-agent run spawned
  // under it. Sub-agent events carry the SUB's own runId (agent §2.3), not the
  // turn's, so approvals/questions raised inside a delegation must be matched
  // against this set — not just `runId`. Without it a sub-agent's high-risk
  // call hangs unanswered until its wall-clock timeout, which is exactly what
  // made delegation look broken from `ea run` (cli §5 / §6.2).
  const turnRuns = new Set<string>([runId]);

  return await new Promise<number>((resolveExit) => {
    // Resolve exactly once: detach the event listener AND the SIGINT handler so
    // neither leaks past the run (the handler would otherwise outlive `runHeadless`
    // and swallow the next Ctrl-C).
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      process.off('SIGINT', onSigint);
      renderer.finish();
      resolveExit(code);
    };

    // Ctrl-C in a headless run must tear down gracefully: abort the in-flight
    // turn (which cascades to its sub-agents via the shared abort signal) so the
    // run-finish path runs, then let `withCtx`'s `finally` dispose the host —
    // closing MCP child processes. Without this, the default SIGINT kills the
    // process immediately, orphaning MCP subprocesses and skipping the audit flush.
    const onSigint = (): void => {
      ctx.host.abortRun(runId);
      finish(EXIT.interrupted);
    };
    process.on('SIGINT', onSigint);

    const unsubscribe = ctx.host.onEvent((e: AgentStreamEvent) => {
      renderer.onEvent(e);

      // Admit a sub-agent run spawned under this turn (parent is the turn or an
      // already-admitted sub-run) so all of its later events resolve here too.
      if (e.kind === 'sub-agent-start' && turnRuns.has(e.parentRunId)) {
        turnRuns.add(e.runId);
        return;
      }

      // Apply the approval policy as soon as a gate is hit — for the turn OR any
      // of its sub-agents.
      if (e.kind === 'tool-approval-required' && turnRuns.has(e.runId)) {
        const decision = decide(policy, { toolName: e.toolName, grantScope: e.grantScope, input: e.input });
        if (decision === 'reject') rejected = true;
        ctx.host.approveTool(e.toolCallId, decision);
        return;
      }

      // No human to choose in a headless run: dismiss the question (null) so the
      // run unwinds instead of hanging; the tool reports the dismissal and the
      // model proceeds on its own judgement (cli §6.2, same spirit as reject).
      if (e.kind === 'user-question-required' && turnRuns.has(e.runId)) {
        ctx.host.answerQuestion(e.questionId, null);
        return;
      }

      // A plan proposal (exitPlanMode) suspends the run awaiting a human decision.
      // There's no human here, so we must resolve it or the run hangs forever.
      // Approving pre-grants the plan's high-risk actions, so we only do that when
      // the user explicitly opted into auto-approval (`--approve auto:*`); under
      // the fail-closed default (reject) or a fine-grained policy we reject the
      // plan and let the run unwind (cli §6.2 fail-closed spirit).
      if (e.kind === 'plan-proposed' && turnRuns.has(e.runId)) {
        if (policy.mode === 'auto') {
          ctx.host.approvePlan(e.planId, 'approve');
        } else {
          rejected = true;
          ctx.host.approvePlan(e.planId, 'reject');
        }
        return;
      }

      // The turn ends on the ORCHESTRATOR run only: sub-agents emit
      // sub-agent-finish (not run-finish), and a sub-agent error surfaces to the
      // orchestrator as a tool result rather than ending the whole turn.
      if (e.kind === 'run-finish' && e.runId === runId) {
        finish(rejected ? EXIT.rejected : EXIT.ok);
      } else if (e.kind === 'error' && e.runId === runId) {
        finish(EXIT.error);
      }
    });
  });
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]!.trim();
  return firstLine.length > 48 ? firstLine.slice(0, 47) + '…' : firstLine || 'Run';
}
