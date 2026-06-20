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
 * Gate + run + audit. Returns the tool result, or throws ToolRejectedError if
 * the user rejected (the runtime feeds that back to the agent as a result).
 */
export async function gated<T>(
  ctx: RunContext,
  call: GatedToolCall,
  run: () => Promise<T>,
): Promise<T> {
  const { approval, audit } = ctx.shared;
  const result = await approval.gate({
    runId: ctx.runId,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    agentId: ctx.agentId,
    parentAgentId: ctx.parentAgentId,
    input: call.input,
    grantKey: call.grantKey,
    grantScope: call.grantScope,
    agentScoped: call.agentScoped,
  });

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
