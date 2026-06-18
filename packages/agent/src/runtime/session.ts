/**
 * Session driver (agent §2 / §5 / §6). One Session manages one Work or Chat:
 * builds the orchestrator, streams its run, maps stream parts to §6.2 events,
 * persists entries to the append-only session tree, accounts tokens, and runs
 * threshold/overflow compaction. Mirrors the desktop utilityProcess model
 * (one session = one process), but is host-agnostic.
 */
import type { ModelMessage } from 'ai';
import type {
  AgentStreamEvent,
  Entry,
  Todo,
} from '@enterprise-agent/agent-contract';
import type { SessionServices, RunContext } from './context.js';
import { createOrchestrator } from './orchestrator.js';
import { generateReport } from './report.js';
import { Compactor, crossesThreshold, RECENT_TAIL } from './compactor.js';
import { toTokenUsage } from './usage.js';
import { buildSystemPrompt } from './prompts.js';
import {
  consumeStreamPart,
  createPartSink,
  isContextOverflowError,
  resetSink,
  type StreamPart,
} from './stream-events.js';
import type { SessionStore } from '../storage/session-store.js';

const ORCH_AGENT_ID = 'orch';

export interface SessionConfig {
  goal: string;
  skillCatalog: string;
  maxSteps: number;
  compactRatio: number;
  /** Concrete ref of the orchestrator model, for cost accounting. */
  orchestratorModelRef: string;
}

export class Session {
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly services: SessionServices,
    private readonly store: SessionStore,
    private readonly config: SessionConfig,
  ) {}

  get sessionId(): string {
    return this.services.sessionId;
  }

  approveTool(toolCallId: string, decision: Parameters<SessionServices['approval']['resolve']>[1]): boolean {
    return this.services.approval.resolve(toolCallId, decision);
  }

  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false; // not our run — don't touch this session's approvals
    controller.abort();
    this.services.approval.rejectAll();
    return true;
  }

  getTodos(): Todo[] {
    return this.services.getTodos();
  }

  getTree() {
    return this.store.getTree();
  }

  fork(entryId: string): void {
    this.store.fork(entryId);
  }

  label(entryId: string, label: string): void {
    this.store.label(entryId, label);
  }

  /**
   * Run one orchestrator turn. Returns the runId synchronously and streams in
   * the background; `completion` resolves when the turn finishes (agent §6).
   */
  send(userText: string): { runId: string; completion: Promise<void> } {
    // Persist the user turn, then assemble the active-path context.
    const userEntry = this.store.appendEntry({
      agentId: ORCH_AGENT_ID,
      kind: 'user',
      content: [{ type: 'text', text: userText }],
    });
    this.emitEntry(userEntry.id);

    const abort = new AbortController();
    const run = this.services.runs.start({
      agentId: ORCH_AGENT_ID,
      rootEntryId: userEntry.id,
    });
    this.controllers.set(run.id, abort);
    const completion = this.drive(run.id, userEntry, abort);
    return { runId: run.id, completion };
  }

  private async drive(runId: string, userEntry: Entry, abort: AbortController): Promise<void> {
    const run = { id: runId };

    const ctx: RunContext = {
      shared: this.services,
      runId: run.id,
      agentId: ORCH_AGENT_ID,
      depth: 0,
      rootEntryId: userEntry.id,
      needsCompaction: { value: false },
      abortSignal: abort.signal,
    };

    const lastInputTokens = { value: 0 };
    const sink = createPartSink();
    let finishReason = 'stop';

    const meta = this.services.meta.get(this.config.orchestratorModelRef);
    const compactor = new Compactor(this.services.modelFor('orchestrator'));

    /** Append a summary entry on the active path + emit the §6.2 events. */
    const appendSummary = (reason: 'threshold' | 'overflow', result: { summaryText: string; tokensBefore: number; tokensAfter: number }) => {
      const firstKept = this.store.headId ?? userEntry.id;
      const summaryEntry = this.store.appendEntry({
        agentId: ORCH_AGENT_ID,
        runId: run.id,
        kind: 'summary',
        summary: { reason, firstKeptEntryId: firstKept, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter },
        content: [{ type: 'text', text: result.summaryText }],
      });
      this.services.emit({
        kind: 'compaction-end',
        runId: run.id,
        summaryEntryId: summaryEntry.id,
        firstKeptEntryId: firstKept,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      });
    };

    const agent = createOrchestrator(ctx, {
      systemPrompt: buildSystemPrompt(this.config.goal, this.config.skillCatalog),
      maxSteps: this.config.maxSteps,
      // Active compaction (agent §5.5): rewrite messages before a step when flagged.
      prepareStep: async ({ messages }) => {
        if (!ctx.needsCompaction.value) return {};
        ctx.needsCompaction.value = false;
        this.services.emit({ kind: 'compaction-start', runId: run.id, reason: 'threshold' });
        const result = await compactor.summarize(messages as ModelMessage[], meta, lastInputTokens.value);
        appendSummary('threshold', result);
        return { messages: result.newMessages };
      },
    });

    // One streamed attempt over the given messages; accumulates into `sink`.
    const runStream = async (messages: ModelMessage[]): Promise<void> => {
      const stream = await agent.stream({
        messages,
        abortSignal: abort.signal,
        onStepFinish: ({ usage }: { usage: unknown }) => {
          const u = toTokenUsage(usage);
          lastInputTokens.value = u.inputTokens;
          const cost = this.services.accountant.record(run.id, ORCH_AGENT_ID, this.config.orchestratorModelRef, u);
          this.services.emit({ kind: 'step-finish', runId: run.id, agentId: ORCH_AGENT_ID, usage: u });
          this.services.emit({
            kind: 'usage',
            runId: run.id,
            agentId: ORCH_AGENT_ID,
            usage: u,
            totalUsage: toTokenUsage(this.services.accountant.workTotals()),
            cost,
          });
          // Threshold: set the flag from real inputTokens (agent §5.5).
          if (crossesThreshold(u.inputTokens, meta, this.config.compactRatio)) {
            ctx.needsCompaction.value = true;
          }
        },
      });
      for await (const part of stream.fullStream as AsyncIterable<StreamPart>) {
        consumeStreamPart(this.services.emit, run.id, ORCH_AGENT_ID, part, sink);
      }
    };

    const messages = this.buildMessages();
    try {
      await runStream(messages);
    } catch (err) {
      // Overflow fallback (agent §5.5): threshold lags one step; if the provider
      // reports context overrun, compact emergency-style and retry once.
      if (!abort.signal.aborted && isContextOverflowError(err)) {
        try {
          this.services.emit({ kind: 'compaction-start', runId: run.id, reason: 'overflow' });
          const result = await compactor.summarize(messages, meta, lastInputTokens.value);
          appendSummary('overflow', result);
          resetSink(sink);
          await runStream(result.newMessages);
        } catch (err2) {
          finishReason = abort.signal.aborted ? 'aborted' : 'error';
          this.services.emit({ kind: 'error', runId: run.id, message: String(err2) });
        }
      } else {
        finishReason = abort.signal.aborted ? 'aborted' : 'error';
        this.services.emit({ kind: 'error', runId: run.id, message: String(err) });
      }
    }

    // Persist the assistant turn as v6 content parts (agent §5.3); skip a fully
    // empty turn (e.g. immediate abort) to avoid noise entries.
    if (sink.parts.length) {
      const assistantEntry = this.store.appendEntry({
        agentId: ORCH_AGENT_ID,
        runId: run.id,
        kind: 'assistant',
        content: sink.parts,
      });
      this.emitEntry(assistantEntry.id);
    }

    this.services.runs.finish(run.id, finishReason === 'error' ? 'error' : finishReason === 'aborted' ? 'aborted' : 'done', finishReason);
    this.services.emit({ kind: 'run-finish', runId: run.id, finishReason });
    this.controllers.delete(run.id);
  }

  /** Structured-output run (agent §2.4). Returns the typed report object. */
  async report(prompt: string): Promise<unknown> {
    const abort = new AbortController();
    const run = this.services.runs.start({ agentId: ORCH_AGENT_ID });
    this.controllers.set(run.id, abort);
    const ctx: RunContext = {
      shared: this.services,
      runId: run.id,
      agentId: ORCH_AGENT_ID,
      depth: 0,
      needsCompaction: { value: false },
      abortSignal: abort.signal,
    };
    try {
      const out = await generateReport(ctx, prompt);
      this.services.runs.finish(run.id, 'done', 'report');
      this.services.emit({ kind: 'run-finish', runId: run.id, finishReason: 'report' });
      return out;
    } catch (err) {
      this.services.runs.finish(run.id, 'error', String(err));
      this.services.emit({ kind: 'error', runId: run.id, message: String(err) });
      this.services.emit({ kind: 'run-finish', runId: run.id, finishReason: 'error' });
      throw err;
    } finally {
      this.controllers.delete(run.id);
    }
  }

  /** Manual compaction (agent §5.5 `manual`). */
  async compactManual(): Promise<void> {
    const path = this.store.getPath();
    if (path.length < 2) return;
    const compactor = new Compactor(this.services.modelFor('orchestrator'));
    const meta = this.services.meta.get(this.config.orchestratorModelRef);
    const messages = this.buildMessages();
    this.services.emit({ kind: 'compaction-start', runId: 'manual', reason: 'manual' });
    const result = await compactor.summarize(messages, meta, 0);

    // The recent tail the summary did NOT fold in; firstKept points at its start.
    const keptTail = path.filter((e) => e.kind !== 'summary').slice(-RECENT_TAIL);
    const firstKept = keptTail[0]?.id ?? this.store.headId!;
    const summaryEntry = this.store.appendEntry({
      agentId: ORCH_AGENT_ID,
      kind: 'summary',
      summary: {
        reason: 'manual',
        firstKeptEntryId: firstKept,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      },
      content: [{ type: 'text', text: result.summaryText }],
    });
    // Re-anchor the recent tail under the summary so the active path stays
    // "summary + subsequent messages" (agent §5.5); the originals remain in the
    // tree for navigation. Without this, the next turn would see only the summary.
    for (const e of keptTail) {
      this.store.appendEntry({ agentId: e.agentId, kind: e.kind, content: e.content });
    }
    this.services.emit({
      kind: 'compaction-end',
      runId: 'manual',
      summaryEntryId: summaryEntry.id,
      firstKeptEntryId: firstKept,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    });
  }

  // -- helpers --

  /** Active path entries → model messages (agent §5.4 / §5.6). */
  private buildMessages(): ModelMessage[] {
    const path = this.store.getPath();
    const out: ModelMessage[] = [];
    for (const e of path) {
      const text = textOf(e);
      if (!text) continue;
      if (e.kind === 'user') out.push({ role: 'user', content: text });
      else if (e.kind === 'assistant') out.push({ role: 'assistant', content: text });
      else if (e.kind === 'summary') out.push({ role: 'user', content: `[Earlier context summary]\n${text}` });
    }
    return out;
  }

  private emitEntry(entryId: string): void {
    this.services.emit({ kind: 'entry-appended', sessionId: this.services.sessionId, entryId });
  }
}

function textOf(entry: Entry): string {
  if (!entry.content) return '';
  return entry.content
    .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .join('');
}

export type { SessionStore };
