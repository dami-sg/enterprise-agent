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

  return await new Promise<number>((resolveExit) => {
    const unsubscribe = ctx.host.onEvent((e: AgentStreamEvent) => {
      renderer.onEvent(e);

      // Apply the approval policy as soon as a gate is hit (this run only).
      if (e.kind === 'tool-approval-required' && e.runId === runId) {
        const decision = decide(policy, { toolName: e.toolName, grantScope: e.grantScope, input: e.input });
        if (decision === 'reject') rejected = true;
        ctx.host.approveTool(e.toolCallId, decision);
        return;
      }

      // No human to choose in a headless run: dismiss the question (null) so the
      // run unwinds instead of hanging; the tool reports the dismissal and the
      // model proceeds on its own judgement (cli §6.2, same spirit as reject).
      if (e.kind === 'user-question-required' && e.runId === runId) {
        ctx.host.answerQuestion(e.questionId, null);
        return;
      }

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
