/** Normalize AI SDK v6 LanguageModelUsage into our TokenUsage (agent §2.7). */
import {
  ORCHESTRATOR_AGENT_ID,
  type AgentStreamEvent,
  type TokenUsage,
  type UsageCategory,
  type UsageTotals,
} from '@dami-sg/agent-contract';
import type { Accountant } from './accountant.js';
import type { ModelMetaRegistry } from '../models/meta.js';
import type { UsageLedger } from '../storage/usage-ledger.js';

export function toTokenUsage(u: unknown): TokenUsage {
  const usage = (u ?? {}) as Record<string, number | undefined>;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };
}

/**
 * Stable agent ids for the agent's own (non-conversational) model calls, so the
 * accountant's per-agent dimension separates this overhead from real inference
 * (agent §2.7). The main orchestrator uses its run agent id; these cover the
 * auxiliary calls (compaction summary, auto-mode classifier, title generation).
 */
export const SYSTEM_AGENT = {
  compaction: 'system:compaction',
  classifier: 'system:classifier',
  title: 'system:title',
} as const;

/** The slice of session services `recordAuxUsage` needs (kept structural to
 *  avoid importing the full `SessionServices` and its dependency graph). */
export interface UsageSink {
  accountant: Accountant;
  meta: ModelMetaRegistry;
  emit(event: AgentStreamEvent): void;
  persistUsage(usage: UsageTotals, lastInputTokens?: number): void;
  sessionId: string;
  /** Durable analytics ledger (agent §2.7); absent in unit tests → no-op. */
  usageLedger?: UsageLedger;
}

/** Map an agentId to a usage category for the system-overhead split (agent §2.7). */
export function categoryOf(agentId: string): UsageCategory {
  if (agentId === ORCHESTRATOR_AGENT_ID) return 'orchestrator';
  if (agentId === SYSTEM_AGENT.compaction) return 'compaction';
  if (agentId === SYSTEM_AGENT.classifier) return 'classifier';
  if (agentId === SYSTEM_AGENT.title) return 'title';
  return 'sub-agent';
}

/**
 * Append one usage fact to the analytics ledger (agent §2.7). Centralizes the
 * derived fields (provider, category) so every capture point — orchestrator,
 * sub-agent, and the auxiliary calls — writes an identically-shaped event.
 * No-ops when no ledger is wired (tests).
 */
export function appendUsageEvent(
  svc: UsageSink,
  ev: { ts: number; runId: string; agentId: string; modelRef: string; usage: TokenUsage; cost: number; entryId?: string },
): void {
  if (!svc.usageLedger) return;
  svc.usageLedger.append({
    ts: ev.ts,
    sessionId: svc.sessionId,
    runId: ev.runId,
    agentId: ev.agentId,
    modelRef: ev.modelRef,
    provider: ev.modelRef.includes(':') ? ev.modelRef.slice(0, ev.modelRef.indexOf(':')) : ev.modelRef,
    category: categoryOf(ev.agentId),
    entryId: ev.entryId,
    usage: ev.usage,
    cost: ev.cost,
  });
}

/**
 * Record + expose the token usage of one auxiliary (non-orchestrator) model call
 * — compaction, classifier, title (agent §2.7). Folds it into the accountant
 * (so session totals/cost include it), persists the new totals WITHOUT touching
 * the orchestrator's context-occupancy gauge (`lastInputTokens` omitted), and
 * emits a `usage` event so the live UI reflects it. No-ops when the provider
 * reported no usage (e.g. a mock model), so callers stay unconditional.
 */
export function recordAuxUsage(
  svc: UsageSink,
  runId: string,
  agentId: string,
  modelRef: string,
  rawUsage: unknown,
): void {
  if (rawUsage == null) return;
  const u = toTokenUsage(rawUsage);
  if (!u.inputTokens && !u.outputTokens) return;
  const cost = svc.accountant.record(runId, agentId, modelRef, u);
  const totals = svc.accountant.workTotals();
  svc.persistUsage(totals);
  appendUsageEvent(svc, { ts: Date.now(), runId, agentId, modelRef, usage: u, cost });
  const m = svc.meta.get(modelRef);
  svc.emit({
    kind: 'usage',
    runId,
    agentId,
    usage: u,
    totalUsage: toTokenUsage(totals),
    cost: totals.cost,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
  });
}
