/**
 * Headless run approval routing (cli §5 / §6.2). A delegation's high-risk tool
 * call is raised under the SUB-agent's runId, not the turn's. The headless
 * runner must still answer it via the --approve policy; otherwise the sub-agent
 * hangs until its wall-clock timeout and delegation looks broken. These tests
 * drive runHeadless against a scripted fake host and assert the policy reaches
 * sub-agent approvals/questions — scoped to the turn's run tree, not globally.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AgentStreamEvent } from '@enterprise-agent/agent-contract';
import { runHeadless, EXIT } from '../src/headless/run.js';
import type { CliContext } from '../src/host/bootstrap.js';

const ORCH = 'orch-run';
const SUB = 'sub-run';

/** A host that, on subscribe, plays a scripted event sequence. */
function fakeHost(script: (emit: (e: AgentStreamEvent) => void) => void) {
  const approvals: { toolCallId: string; decision: string }[] = [];
  const questions: string[] = [];
  const plans: { planId: string; decision: string }[] = [];
  let listener: ((e: AgentStreamEvent) => void) | undefined;
  const host = {
    async startSession() {
      return { sessionId: 's1', runId: ORCH };
    },
    async sendMessage() {
      return { runId: ORCH };
    },
    onEvent(l: (e: AgentStreamEvent) => void) {
      listener = l;
      queueMicrotask(() => script((e) => listener?.(e)));
      return () => {
        listener = undefined;
      };
    },
    approveTool(toolCallId: string, decision: string) {
      approvals.push({ toolCallId, decision });
    },
    answerQuestion(questionId: string) {
      questions.push(questionId);
    },
    approvePlan(planId: string, decision: string) {
      plans.push({ planId, decision });
    },
  };
  return { ctx: { host } as unknown as CliContext, approvals, questions, plans };
}

/** A plan proposal (exitPlanMode) suspending the orchestrator run. */
function planProposal(emit: (e: AgentStreamEvent) => void): void {
  emit({
    kind: 'plan-proposed',
    runId: ORCH,
    agentId: 'orch',
    planId: 'plan-1',
    plan: 'step 1, step 2',
    allowedActions: [{ tool: 'runCommand', grantKey: 'npm', reason: 'build' }],
  });
  emit({ kind: 'run-finish', runId: ORCH, finishReason: 'stop' });
}

/** The canonical delegation sequence: a sub-agent raises a writeFile approval. */
function delegationWithApproval(emit: (e: AgentStreamEvent) => void): void {
  emit({
    kind: 'sub-agent-start',
    runId: SUB,
    parentRunId: ORCH,
    parentAgentId: 'orch',
    agentId: 'sub-coder-1',
    role: 'coder',
    toolCallId: 'delegate-1',
  });
  emit({
    kind: 'tool-approval-required',
    runId: SUB, // the SUB's runId, not the turn's — the crux of the bug
    agentId: 'sub-coder-1',
    parentAgentId: 'orch',
    toolCallId: 'write-1',
    toolName: 'writeFile',
    input: { path: 'out.txt' },
    grantScope: 'write files under out',
  });
  emit({ kind: 'sub-agent-finish', runId: SUB, agentId: 'sub-coder-1', summary: 'done' });
  emit({ kind: 'run-finish', runId: ORCH, finishReason: 'stop' });
}

describe('headless answers sub-agent approvals via the --approve policy', () => {
  it('auto:session approves the sub-agent writeFile (not just the orchestrator run)', async () => {
    const { ctx, approvals } = fakeHost(delegationWithApproval);
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true, approve: 'auto:session' });
    expect(approvals).toEqual([{ toolCallId: 'write-1', decision: 'session' }]);
    expect(code).toBe(EXIT.ok);
  });

  it('reject policy rejects the sub-agent call and the run exits "rejected"', async () => {
    const { ctx, approvals } = fakeHost(delegationWithApproval);
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true, approve: 'reject' });
    expect(approvals).toEqual([{ toolCallId: 'write-1', decision: 'reject' }]);
    expect(code).toBe(EXIT.rejected);
  });

  it('dismisses a sub-agent user-question (null) so the run never hangs', async () => {
    const { ctx, questions } = fakeHost((emit) => {
      emit({
        kind: 'sub-agent-start',
        runId: SUB,
        parentRunId: ORCH,
        parentAgentId: 'orch',
        agentId: 'sub-generalist-1',
        role: 'generalist',
        toolCallId: 'delegate-1',
      });
      emit({
        kind: 'user-question-required',
        runId: SUB,
        agentId: 'sub-generalist-1',
        parentAgentId: 'orch',
        questionId: 'q-1',
        questions: [],
      });
      emit({ kind: 'sub-agent-finish', runId: SUB, agentId: 'sub-generalist-1', summary: 'done' });
      emit({ kind: 'run-finish', runId: ORCH, finishReason: 'stop' });
    });
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true });
    expect(questions).toEqual(['q-1']);
    expect(code).toBe(EXIT.ok);
  });

  it('approves a plan proposal under an auto-approve policy so the run completes', async () => {
    const { ctx, plans } = fakeHost(planProposal);
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true, approve: 'auto:session' });
    expect(plans).toEqual([{ planId: 'plan-1', decision: 'approve' }]);
    expect(code).toBe(EXIT.ok);
  });

  it('rejects a plan proposal under the fail-closed default (never hangs)', async () => {
    const { ctx, plans } = fakeHost(planProposal);
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true });
    expect(plans).toEqual([{ planId: 'plan-1', decision: 'reject' }]);
    expect(code).toBe(EXIT.rejected);
  });

  it('rejects a plan proposal under a fine-grained policy file', async () => {
    const { ctx, plans } = fakeHost(planProposal);
    // `reject` policy mode is not `auto`, so the plan is rejected rather than
    // wholesale pre-granted.
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true, approve: 'reject' });
    expect(plans).toEqual([{ planId: 'plan-1', decision: 'reject' }]);
    expect(code).toBe(EXIT.rejected);
  });

  it('does NOT answer an approval from a run outside this turn tree (run-tree scoping)', async () => {
    const { ctx, approvals } = fakeHost((emit) => {
      // An approval whose runId was never linked to the turn via sub-agent-start.
      emit({
        kind: 'tool-approval-required',
        runId: 'unrelated-run',
        agentId: 'somebody',
        toolCallId: 'x-1',
        toolName: 'writeFile',
        input: {},
        grantScope: 'x',
      });
      emit({ kind: 'run-finish', runId: ORCH, finishReason: 'stop' });
    });
    const code = await runHeadless(ctx, { prompt: 'go', quiet: true, approve: 'auto:session' });
    expect(approvals).toEqual([]); // scoping holds: unrelated run is ignored
    expect(code).toBe(EXIT.ok);
  });
});
