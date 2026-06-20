/**
 * Helper that runs a high-risk tool through the three-state approval gate
 * (agent §3.3) and writes the audit record. Read-only tools skip this.
 */
import type { RunContext } from '../runtime/context.js';

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

/**
 * Commands whose grant/allowlist must NOT auto-allow in auto mode — a bare
 * interpreter would let the classifier be bypassed (`bash -c "rm -rf"`). In auto
 * mode these are always re-classified, regardless of an existing grant/allowlist
 * (agent §3.8.5 guardrail 1, "dangerous grant stripping" — done read-time).
 */
export const DANGEROUS_AUTO_COMMANDS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'node', 'deno', 'bun', 'python', 'python3',
  'ruby', 'perl', 'php', 'eval', 'exec', 'sudo', 'doas', 'su', 'powershell', 'pwsh',
]);

/** Whether this call would bypass the classifier if a grant honored it (agent §3.8.5). */
function isDangerousInAuto(call: GatedToolCall): boolean {
  if (call.toolName === 'runScript') return true; // grantKey IS the interpreter
  if (call.toolName === 'runCommand') return DANGEROUS_AUTO_COMMANDS.has(call.grantKey);
  return false;
}

/**
 * Gate + run + audit. Returns the tool result, or throws ToolRejectedError if
 * the user rejected (the runtime feeds that back to the agent as a result). In
 * auto mode, a safety classifier adjudicates instead of prompting (agent §3.8.5).
 */
export async function gated<T>(
  ctx: RunContext,
  call: GatedToolCall,
  run: () => Promise<T>,
): Promise<T | { error: 'auto_denied'; reason: string }> {
  const { approval, audit } = ctx.shared;

  // Auto mode (agent §3.8.5): classify in place of prompting. An existing SESSION
  // grant is still honored (skips the classifier) UNLESS it covers a dangerous
  // interpreter — those are always re-classified so a prior `bash` grant can't be
  // weaponized. On 'ask' (incl. classifier-unavailable) we fall through to the
  // human gate below — fail-closed, never silently allow.
  if (ctx.shared.executionMode.value === 'auto' && ctx.shared.auto.enabled) {
    const dangerous = isDangerousInAuto(call);
    const granted = !dangerous && approval.isGranted(call.toolName, call.grantKey, ctx.agentId);
    if (!granted) {
      const verdict = await ctx.shared.auto.classify(
        { toolName: call.toolName, grantKey: call.grantKey, input: call.input },
        ctx.abortSignal,
      );
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
