/**
 * Vercel AI SDK "UI message stream" encoder (web-app §4.2). Translates the
 * host's `AgentStreamEvent`s for one orchestrator run into the SSE wire format
 * that the frontend's `useChat` consumes directly — so the Web chat speaks the
 * same protocol as a Vercel ai-chatbot backend without us hand-rolling a client.
 *
 * Wire format (AI SDK data stream protocol, custom backend):
 *   - each part is one SSE event: `data: <json>\n\n`
 *   - response carries header `x-vercel-ai-ui-message-stream: v1`
 *   - parts: start · text-start{id} · text-delta{id,delta} · text-end{id} ·
 *            finish · error{errorText} · data-*{...}
 *   - terminated by `data: [DONE]\n\n`
 *
 * The agent produces its own deltas (it is not the AI SDK's `streamText`), so we
 * map events → parts manually here rather than via `toUIMessageStream`.
 */
import { ORCHESTRATOR_AGENT_ID, type AgentStreamEvent } from '@enterprise-agent/agent-contract';

/** Response headers for an AI SDK UI message stream from a custom backend. */
export const UI_MESSAGE_STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
};

export type UiMessagePart =
  | { type: 'start' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | { type: 'finish' }
  | { type: 'error'; errorText: string }
  // A `data-*` part may carry an `id`; the AI SDK reconciles repeat writes of the
  // same id (so the host could later overwrite a prompt to mark it resolved).
  | { type: `data-${string}`; id?: string; data: unknown };

/** Live progress for one delegated sub-agent, streamed as a `data-subagent` card. */
interface SubAgentProgress {
  role: string;
  status: 'running' | 'done';
  /** Tool names the sub-agent has called so far (its execution process). */
  activity: string[];
  /** Final summary text, once finished. */
  summary?: string;
}

/** Compact, bounded summary of a tool input for the approval card (no huge payloads). */
function approvalDetail(input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'path', 'url', 'file']) {
    const v = o[k];
    if (typeof v === 'string' && v) return v.length > 300 ? v.slice(0, 299) + '…' : v;
  }
  return undefined;
}

/** Frame one part as an SSE event. */
export function sseLine(part: UiMessagePart): string {
  return `data: ${JSON.stringify(part)}\n\n`;
}

/** SSE stream terminator the AI SDK expects. */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * Stateful encoder for ONE orchestrator run. Feed it host events via `onEvent`;
 * it returns the SSE chunks to write (0..n per event). Manages the single
 * assistant text part's start/delta/end lifecycle and the terminal finish.
 */
export class UiMessageStreamEncoder {
  private readonly runId: string;
  /** The session this run belongs to — gates session-scoped events (todos) so one
   *  account's stream never leaks another session's data. */
  private readonly sessionId?: string;
  private readonly textId: string;
  private readonly reasoningId: string;
  private started = false;
  private textOpen = false;
  private reasoningOpen = false;
  private done = false;
  /** Sub-run ids spawned under this turn — their events carry their own runId,
   *  not the turn's, so we admit them explicitly (mirrors the IM dispatcher). */
  private readonly subRuns = new Set<string>();
  /** Live per-sub-agent progress, keyed by the sub-agent's agentId. */
  private readonly subAgents = new Map<string, SubAgentProgress>();

  constructor(opts: { runId: string; sessionId?: string; textId?: string }) {
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
    this.textId = opts.textId ?? `msg-${opts.runId}`;
    this.reasoningId = `reason-${opts.runId}`;
  }

  onEvent(e: AgentStreamEvent): string[] {
    if (this.done) return [];

    // Sub-agent lifecycle/activity (agent §2.3). A delegated run streams under its
    // OWN runId, so the turn-scoped `runId` checks below would drop it; admit it
    // here and fold it into a single reconciled `data-subagent` card per sub-agent
    // (status running→done, plus the tool calls it makes = its execution process).
    if (e.kind === 'sub-agent-start') {
      if (e.parentRunId !== this.runId && !this.subRuns.has(e.parentRunId)) return [];
      this.subRuns.add(e.runId);
      this.subAgents.set(e.agentId, { role: e.role, status: 'running', activity: [] });
      return [...this.ensureStarted(), this.subAgentPart(e.agentId)];
    }
    if (e.kind === 'sub-agent-finish') {
      const s = this.subAgents.get(e.agentId);
      if (!s) return [];
      s.status = 'done';
      s.summary = e.summary;
      return [...this.ensureStarted(), this.subAgentPart(e.agentId)];
    }
    if (e.kind === 'tool-call' && this.subRuns.has(e.runId)) {
      const s = this.subAgents.get(e.agentId);
      if (!s) return [];
      if (s.activity.length < 100) s.activity.push(e.toolName);
      return [...this.ensureStarted(), this.subAgentPart(e.agentId)];
    }

    switch (e.kind) {
      case 'text-delta':
        if (e.runId !== this.runId || e.agentId !== ORCHESTRATOR_AGENT_ID) return [];
        return [...this.ensureTextOpen(), sseLine({ type: 'text-delta', id: this.textId, delta: e.text })];
      case 'reasoning-delta':
        // Stream thinking as native reasoning parts (useChat accumulates them).
        if (e.runId !== this.runId || e.agentId !== ORCHESTRATOR_AGENT_ID) return [];
        return [...this.ensureReasoningOpen(), sseLine({ type: 'reasoning-delta', id: this.reasoningId, delta: e.text })];
      case 'tool-call':
        if (e.runId !== this.runId || e.agentId !== ORCHESTRATOR_AGENT_ID) return [];
        // The delegate call is represented by its own sub-agent card, not a chip.
        if (e.toolName === 'delegateToSubAgent') return this.ensureStarted();
        return [...this.ensureStarted(), sseLine({ type: 'data-tool', data: { id: e.toolCallId, name: e.toolName } })];
      case 'tool-approval-required':
        // The run is suspended awaiting the user's decision; surface an interactive
        // card and keep the stream open (no finish). The host resumes via approveTool
        // (POST /api/respond) — see run-stream.ts for the account-scoped registry.
        if (e.runId !== this.runId) return [];
        return [
          ...this.ensureStarted(),
          sseLine({
            type: 'data-approval',
            id: e.toolCallId,
            data: { toolCallId: e.toolCallId, toolName: e.toolName, grantScope: e.grantScope, detail: approvalDetail(e.input) },
          }),
        ];
      case 'user-question-required':
        if (e.runId !== this.runId) return [];
        return [
          ...this.ensureStarted(),
          sseLine({ type: 'data-question', id: e.questionId, data: { questionId: e.questionId, questions: e.questions } }),
        ];
      case 'plan-proposed':
        if (e.runId !== this.runId) return [];
        return [
          ...this.ensureStarted(),
          sseLine({ type: 'data-plan', id: e.planId, data: { planId: e.planId, plan: e.plan, allowedActions: e.allowedActions } }),
        ];
      case 'todo-update':
        // Session-scoped (no runId). A stable part id lets useChat reconcile each
        // update in place, so the task list updates live instead of stacking.
        if (!this.sessionId || e.sessionId !== this.sessionId) return [];
        return [...this.ensureStarted(), sseLine({ type: 'data-todos', id: 'todos', data: { todos: e.todos } })];
      case 'memory-captured':
        if (e.runId !== this.runId) return [];
        return [...this.ensureStarted(), sseLine({ type: 'data-memory', data: { count: e.count } })];
      case 'error':
        if (e.runId !== this.runId) return [];
        return this.finishParts(e.message);
      case 'run-finish':
        if (e.runId !== this.runId) return [];
        return this.finishParts();
      default:
        return [];
    }
  }

  /** Force-close the stream (e.g. client disconnect / host teardown). */
  end(): string[] {
    return this.finishParts();
  }

  /** The reconciled `data-subagent` card for one sub-agent (stable id → updates in place). */
  private subAgentPart(agentId: string): string {
    const s = this.subAgents.get(agentId)!;
    return sseLine({
      type: 'data-subagent',
      id: `sub-${agentId}`,
      data: { agentId, role: s.role, status: s.status, activity: s.activity, summary: s.summary },
    });
  }

  private ensureStarted(): string[] {
    if (this.started) return [];
    this.started = true;
    return [sseLine({ type: 'start' })];
  }

  private ensureReasoningOpen(): string[] {
    const out = this.ensureStarted();
    if (!this.reasoningOpen) {
      this.reasoningOpen = true;
      out.push(sseLine({ type: 'reasoning-start', id: this.reasoningId }));
    }
    return out;
  }

  private closeReasoning(): string[] {
    if (!this.reasoningOpen) return [];
    this.reasoningOpen = false;
    return [sseLine({ type: 'reasoning-end', id: this.reasoningId })];
  }

  private ensureTextOpen(): string[] {
    const out = this.ensureStarted();
    out.push(...this.closeReasoning()); // text follows thinking — close the reasoning part first
    if (!this.textOpen) {
      this.textOpen = true;
      out.push(sseLine({ type: 'text-start', id: this.textId }));
    }
    return out;
  }

  private finishParts(errorText?: string): string[] {
    if (this.done) return [];
    this.done = true;
    const out = this.ensureStarted();
    out.push(...this.closeReasoning());
    if (this.textOpen) {
      this.textOpen = false;
      out.push(sseLine({ type: 'text-end', id: this.textId }));
    }
    if (errorText) out.push(sseLine({ type: 'error', errorText }));
    out.push(sseLine({ type: 'finish' }));
    out.push(SSE_DONE);
    return out;
  }
}

/** Convenience for tests / batch encoding: run a full event sequence to a string. */
export function encodeEvents(events: AgentStreamEvent[], opts: { runId: string; textId?: string }): string {
  const enc = new UiMessageStreamEncoder(opts);
  const chunks: string[] = [];
  for (const e of events) chunks.push(...enc.onEvent(e));
  chunks.push(...enc.end());
  return chunks.join('');
}
