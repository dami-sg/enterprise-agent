/**
 * Headless single-run orchestrator (cli §5). Constructs nothing the TUI does
 * not — it shares the host and the event stream, swapping the renderer for a
 * printer (§5.3). Resolves the target session, drives one turn, applies the
 * non-interactive approval policy (§6.2), and maps the outcome to an exit code
 * (§5.4).
 */
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';
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

/** Exit codes per cli §5.4. */
export const EXIT = { ok: 0, error: 1, rejected: 4, bootstrap: 5 } as const;

export async function runHeadless(ctx: CliContext, opts: RunOptions): Promise<number> {
  const policy = parseApprovePolicy(opts.approve);
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

      // The turn ends on the ORCHESTRATOR run only: sub-agents emit
      // sub-agent-finish (not run-finish), and a sub-agent error surfaces to the
      // orchestrator as a tool result rather than ending the whole turn.
      if (e.kind === 'run-finish' && e.runId === runId) {
        unsubscribe();
        renderer.finish();
        resolveExit(rejected ? EXIT.rejected : EXIT.ok);
      } else if (e.kind === 'error' && e.runId === runId) {
        unsubscribe();
        renderer.finish();
        resolveExit(EXIT.error);
      }
    });
  });
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]!.trim();
  return firstLine.length > 48 ? firstLine.slice(0, 47) + '…' : firstLine || 'Run';
}
