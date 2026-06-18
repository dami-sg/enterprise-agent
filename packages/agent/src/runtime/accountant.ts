/**
 * Token usage accounting (agent §2.7). Accumulates four dimensions in memory —
 * per run / per Work (incl. sub-agents) / per Workspace / per model — and
 * computes cost from `ModelMeta.price`. The Work dimension is mirrored to
 * `work.json.usage` so closed Works read without rescanning `session.jsonl`.
 */
import type { TokenUsage, UsageTotals } from '@enterprise-agent/agent-contract';
import { costOf, type ModelMetaRegistry } from '../models/meta.js';

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  };
}

export class Accountant {
  private readonly byRun = new Map<string, UsageTotals>();
  private readonly byAgent = new Map<string, UsageTotals>();
  private readonly byModel = new Map<string, UsageTotals>();
  private readonly work = emptyTotals();

  constructor(private readonly meta: ModelMetaRegistry, seed?: UsageTotals) {
    if (seed) Object.assign(this.work, seed);
  }

  private accumulate(target: UsageTotals, usage: TokenUsage, cost: number): void {
    target.inputTokens += usage.inputTokens ?? 0;
    target.outputTokens += usage.outputTokens ?? 0;
    target.totalTokens += usage.totalTokens ?? 0;
    target.reasoningTokens += usage.reasoningTokens ?? 0;
    target.cachedInputTokens += usage.cachedInputTokens ?? 0;
    target.cost += cost;
  }

  /** Record a single step's usage and return its cost (agent §2.7). */
  record(runId: string, agentId: string, modelRef: string, usage: TokenUsage): number {
    const cost = costOf(
      {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
      },
      this.meta.get(modelRef),
    );
    this.accumulate(this.byRun.get(runId) ?? this.setRun(runId), usage, cost);
    this.accumulate(this.byAgent.get(agentId) ?? this.setAgent(agentId), usage, cost);
    this.accumulate(this.byModel.get(modelRef) ?? this.setModel(modelRef), usage, cost);
    this.accumulate(this.work, usage, cost);
    return cost;
  }

  private setRun(id: string): UsageTotals {
    const t = emptyTotals();
    this.byRun.set(id, t);
    return t;
  }
  private setAgent(id: string): UsageTotals {
    const t = emptyTotals();
    this.byAgent.set(id, t);
    return t;
  }
  private setModel(id: string): UsageTotals {
    const t = emptyTotals();
    this.byModel.set(id, t);
    return t;
  }

  workTotals(): UsageTotals {
    return { ...this.work };
  }
  runTotals(runId: string): UsageTotals {
    return { ...(this.byRun.get(runId) ?? emptyTotals()) };
  }
  agentTotals(agentId: string): UsageTotals {
    return { ...(this.byAgent.get(agentId) ?? emptyTotals()) };
  }
  modelTotals(modelRef: string): UsageTotals {
    return { ...(this.byModel.get(modelRef) ?? emptyTotals()) };
  }
}
