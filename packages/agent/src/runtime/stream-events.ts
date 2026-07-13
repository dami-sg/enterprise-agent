/**
 * Shared mapping from a v6 `fullStream` part to §6.2 stream events, plus
 * accumulation into a persistable content sink. Used by both the orchestrator
 * (agent §2.2) and sub-agents (agent §2.3 pt.4) so the trace tree shows the
 * intermediate text / tool-call / tool-result of every agent, and so a turn is
 * persisted as v6 content parts (agent §5.3), not just a flat text blob.
 */
import type { AgentStreamEvent, MessagePart } from '@dami-sg/agent-contract';
import { stackOf } from '../util/errors.js';

/** Loose shape of a v6 fullStream part — fields read defensively. */
export interface StreamPart {
  type: string;
  text?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  args?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  /** Carried by `finish-step` parts (agent §2.7 token accounting). */
  usage?: unknown;
}

/** Optional hooks for parts that aren't pure trace content (usage accounting). */
export interface StreamHooks {
  /** Called once per `finish-step` with that step's provider-reported usage. */
  onStepUsage?: (usage: unknown) => void;
}

/** Accumulates the streamed turn for persistence (agent §5.3). */
export interface PartSink {
  /** Concatenated assistant text (used for replay, agent §5.6). */
  text: string;
  /** Ordered v6 content parts: text + tool-call + tool-result. */
  parts: MessagePart[];
}

export function createPartSink(): PartSink {
  return { text: '', parts: [] };
}

/** Reset a sink in place (e.g. before an overflow retry, agent §5.5). */
export function resetSink(sink: PartSink): void {
  sink.text = '';
  sink.parts = [];
}

/**
 * Emit the §6.2 event for one stream part and accumulate it into `sink`.
 * Text deltas coalesce into the trailing text part to keep `content` compact.
 */
export function consumeStreamPart(
  emit: (event: AgentStreamEvent) => void,
  runId: string,
  agentId: string,
  part: StreamPart,
  sink: PartSink,
  hooks?: StreamHooks,
): void {
  switch (part.type) {
    case 'text-delta': {
      const text = part.text ?? part.delta ?? '';
      if (!text) return;
      emit({ kind: 'text-delta', runId, agentId, text });
      sink.text += text;
      const last = sink.parts[sink.parts.length - 1] as { type?: string; text?: string } | undefined;
      if (last && last.type === 'text') last.text = `${last.text ?? ''}${text}`;
      else sink.parts.push({ type: 'text', text });
      return;
    }
    case 'reasoning-delta': {
      // Normalized thinking (agent §2.2) — emitted to the UI and persisted as a
      // `reasoning` content part so it survives reload, coalesced like text.
      const text = part.text ?? part.delta ?? '';
      if (!text) return;
      emit({ kind: 'reasoning-delta', runId, agentId, text });
      const last = sink.parts[sink.parts.length - 1] as { type?: string; text?: string } | undefined;
      if (last && last.type === 'reasoning') last.text = `${last.text ?? ''}${text}`;
      else sink.parts.push({ type: 'reasoning', text });
      return;
    }
    case 'finish-step':
      hooks?.onStepUsage?.(part.usage);
      return;
    case 'tool-call': {
      const toolCallId = part.toolCallId ?? '';
      const toolName = part.toolName ?? '';
      const input = part.input ?? part.args;
      emit({ kind: 'tool-call', runId, agentId, toolCallId, toolName, input });
      sink.parts.push({ type: 'tool-call', toolCallId, toolName, input });
      return;
    }
    case 'tool-result': {
      const toolCallId = part.toolCallId ?? '';
      const output = part.output ?? part.result;
      emit({ kind: 'tool-result', runId, agentId, toolCallId, output });
      sink.parts.push({ type: 'tool-result', toolCallId, output });
      return;
    }
    case 'error':
      emit({ kind: 'error', runId, message: String(part.error), stack: stackOf(part.error) });
      return;
    default:
      return;
  }
}

/**
 * Detect a provider "context length exceeded" error (agent §5.5 overflow).
 * Distinct from `finishReason === 'length'` (output truncation). Matched on the
 * provider message/body since each provider uses a different error code.
 */
export function isContextOverflowError(err: unknown): boolean {
  const e = err as { message?: unknown; responseBody?: unknown; cause?: unknown };
  const parts = [e?.message, e?.responseBody, (e?.cause as { message?: unknown } | undefined)?.message]
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
  if (!parts) return false;
  return /context[ _-]?(length|window)|prompt is too long|maximum.*tokens|too many (input )?tokens|context_length_exceeded|input is too long|reduce the length/.test(
    parts,
  );
}
