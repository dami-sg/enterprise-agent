/**
 * Helper that runs a high-risk tool through the three-state approval gate
 * (agent §3.3) and writes the audit record. Read-only tools skip this.
 */
import type { RunContext } from '../runtime/context.js';
import { DANGEROUS_AUTO_COMMANDS } from './risk.js';
import { requiresApprovalInFull } from './full-mode-policy.js';
import { recordAuxUsage, SYSTEM_AGENT } from '../runtime/usage.js';

export interface GatedToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
  /** Auto-allow scope key (argv[0] / dir prefix / host / tool name). */
  grantKey: string;
  /** Human-readable scope text for the approval dialog. */
  grantScope: string;
  agentScoped?: boolean;
}

export class ToolRejectedError extends Error {
  constructor(toolName: string) {
    super(`Tool call '${toolName}' was rejected by the user.`);
    this.name = 'ToolRejectedError';
  }
}

/** Whether this call would skip the classifier if a grant honored it (agent §3.8.5). */
function isDangerousInAuto(call: GatedToolCall): boolean {
  if (call.toolName === 'runScript') return true; // grantKey IS the interpreter
  if (call.toolName === 'runCommand') return DANGEROUS_AUTO_COMMANDS.has(call.grantKey);
  return false;
}

/**
 * Gate + run + audit. Returns the tool result, or throws ToolRejectedError if
 * the user rejected (the runtime feeds that back to the agent as a result). In
 * auto mode a safety classifier adjudicates instead of prompting; in full mode a
 * deterministic high-risk gate does (agent §3.8.5).
 */
export async function gated<T>(
  ctx: RunContext,
  call: GatedToolCall,
  run: () => Promise<T>,
): Promise<T | { error: 'auto_denied'; reason: string }> {
  const { approval, audit } = ctx.shared;
  const mode = ctx.shared.executionMode.value;

  // Full mode (agent §3.8.5): no classifier. Everything runs unprompted EXCEPT
  // the un-exemptible high-risk set, which falls through to the human gate below.
  // An existing SESSION grant is honored UNLESS it covers a dangerous interpreter
  // (always re-gated so a prior `bash` grant can't be weaponized).
  if (mode === 'full') {
    const dangerous = isDangerousInAuto(call);
    const granted = !dangerous && approval.isGranted(call.toolName, call.grantKey, ctx.agentId);
    if (!granted && !requiresApprovalInFull(call)) {
      ctx.shared.emit({
        kind: 'auto-classified',
        runId: ctx.runId,
        agentId: ctx.agentId,
        toolCallId: call.toolCallId,
        verdict: 'allow',
        reason: 'full',
      });
      const output = await run();
      audit.record({
        runId: ctx.runId,
        agentId: ctx.agentId,
        toolCallId: call.toolCallId,
        tool: call.toolName,
        input: call.input,
        output: summarizeOutput(output),
        approval: 'auto-allow',
        grantKey: call.grantKey,
        reason: 'full',
      });
      return output;
    }
    // else (granted, or the high-risk set): fall through to the gate below — a
    // grant is honored by approval.gate, the high-risk set prompts the human.
  } else if (mode === 'auto' && ctx.shared.auto.enabled) {
    // Auto mode: classify in place of prompting. A SESSION grant is honored
    // (skips the classifier) unless it covers a dangerous interpreter. On 'ask'
    // (incl. classifier-unavailable) fall through to the human gate — fail-closed.
    const dangerous = isDangerousInAuto(call);
    const granted = !dangerous && approval.isGranted(call.toolName, call.grantKey, ctx.agentId);
    if (!granted) {
      const verdict = await ctx.shared.auto.classify(
        { toolName: call.toolName, grantKey: call.grantKey, input: call.input },
        ctx.abortSignal,
      );
      // Account for the classifier's own model call(s) (agent §2.7), regardless
      // of the verdict — these tokens are real provider spend.
      for (const ru of verdict.usages ?? []) {
        recordAuxUsage(ctx.shared, ctx.runId, SYSTEM_AGENT.classifier, ctx.shared.auto.modelRef, ru);
      }
      if (verdict.verdict === 'deny') {
        audit.record({
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId: call.toolCallId,
          tool: call.toolName,
          input: call.input,
          approval: 'auto-deny',
          grantKey: call.grantKey,
          reason: verdict.reason,
        });
        ctx.shared.emit({
          kind: 'auto-classified',
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId: call.toolCallId,
          verdict: 'deny',
          reason: verdict.reason,
          stage: verdict.stage,
        });
        return { error: 'auto_denied', reason: verdict.reason };
      }
      if (verdict.verdict === 'allow') {
        ctx.shared.emit({
          kind: 'auto-classified',
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId: call.toolCallId,
          verdict: 'allow',
          reason: verdict.reason,
          stage: verdict.stage,
        });
        const output = await run();
        audit.record({
          runId: ctx.runId,
          agentId: ctx.agentId,
          toolCallId: call.toolCallId,
          tool: call.toolName,
          input: call.input,
          output: summarizeOutput(output),
          approval: 'auto-allow',
          grantKey: call.grantKey,
          reason: verdict.reason,
        });
        return output;
      }
      // verdict 'ask' → fall through to the interactive gate.
    }
  }

  // Unattended run (§7 B.2): every path that reaches here would otherwise block
  // on a human approval that will never come (auto 'ask', full-mode high-risk,
  // or a non-auto mode). Fail closed — deny with a structured result the
  // orchestrator can react to. EXCEPT a call covered by a pre-authorized grant
  // (the schedule's `grants`): those are honored by `approval.gate` below, so a
  // schedule runs exactly the scopes a human granted it and nothing more.
  if (ctx.shared.unattended.value && !approval.isGranted(call.toolName, call.grantKey, ctx.agentId)) {
    audit.record({
      runId: ctx.runId,
      agentId: ctx.agentId,
      toolCallId: call.toolCallId,
      tool: call.toolName,
      input: call.input,
      approval: 'auto-deny',
      grantKey: call.grantKey,
      reason: 'unattended',
    });
    ctx.shared.emit({
      kind: 'auto-classified',
      runId: ctx.runId,
      agentId: ctx.agentId,
      toolCallId: call.toolCallId,
      verdict: 'deny',
      reason: 'unattended: no human to approve (ask→deny)',
    });
    return { error: 'auto_denied', reason: 'unattended: no human to approve (ask→deny)' };
  }

  const result = await approval.gate(
    {
      runId: ctx.runId,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      agentId: ctx.agentId,
      parentAgentId: ctx.parentAgentId,
      input: call.input,
      grantKey: call.grantKey,
      grantScope: call.grantScope,
      agentScoped: call.agentScoped,
    },
    ctx.abortSignal,
  );

  if (result.mode === 'reject') {
    audit.record({
      runId: ctx.runId,
      agentId: ctx.agentId,
      toolCallId: call.toolCallId,
      tool: call.toolName,
      input: call.input,
      approval: 'reject',
      grantKey: call.grantKey,
    });
    throw new ToolRejectedError(call.toolName);
  }

  const approvalMode =
    result.mode === 'session-auto'
      ? 'session-auto'
      : result.mode === 'session'
        ? 'session'
        : 'once';

  const output = await run();

  audit.record({
    runId: ctx.runId,
    agentId: ctx.agentId,
    toolCallId: call.toolCallId,
    tool: call.toolName,
    input: call.input,
    output: summarizeOutput(output),
    approval: approvalMode,
    grantKey: call.grantKey,
    agentScoped: call.agentScoped,
  });

  return output;
}

/** Keep audit records compact — truncate large outputs. */
function summarizeOutput(output: unknown): unknown {
  const json = JSON.stringify(output);
  if (json && json.length > 2000) return { truncated: true, length: json.length };
  return output;
}
