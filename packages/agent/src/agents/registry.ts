/**
 * Agent definitions (dynamic-subagents §D1). With self-generated sub-agents there
 * are NO predefined agents and no registry: the orchestrator synthesizes an
 * ephemeral `AgentDef` per delegation from an `AgentSpec`, it runs once, and it
 * is discarded (never registered). This module keeps only the shared data shape
 * (`AgentDef`) and the capability→policy mapping (`policyFromCapabilities`) used
 * to build that ephemeral def for the role hard gate (agent §3.4).
 */
import type { RoleToolPolicy } from '../runtime/prompts.js';
import type { SubAgentCapability } from '@dami-sg/agent-contract';

/**
 * Build a `RoleToolPolicy` from a capability-token list + MCP allowlist
 * (dynamic-subagents §D2). Turns a runtime-synthesized `AgentSpec` into a policy
 * for the role hard gate. `delegate` is ALWAYS false — dynamic sub-agents never
 * nest (dynamic-subagents §D3). The caller intersects against the envelope first,
 * so any out-of-ceiling token is already gone.
 */
export function policyFromCapabilities(
  capabilities: SubAgentCapability[],
  mcp: false | string[],
): RoleToolPolicy {
  const has = (c: SubAgentCapability): boolean => capabilities.includes(c);
  return {
    file: { read: has('read'), write: has('write') },
    exec: has('exec'),
    http: has('http'),
    delegate: false,
    mcp,
  };
}

/** A resolved (ephemeral) sub-agent definition synthesized at delegation time. */
export interface AgentDef {
  /** Trace/log label; the `sub-<name>-<n>` id derives from it (not a registry key). */
  name: string;
  /** One-line description (unused for dynamic defs; kept for trace symmetry). */
  description: string;
  /** Tool capability hard gate (§3.4), derived from the spec's capabilities. */
  policy: RoleToolPolicy;
  /** The agent's task-specific system prompt. */
  prompt: string;
  /** Optional model override (alias or `provider:model` ref); else session default. */
  model?: string;
  /** Optional wall-clock timeout (ms) override; else the envelope default. */
  timeoutMs?: number;
  /** Origin marker (`<dynamic>` for synthesized defs). */
  dir: string;
  /** Always false now (no built-in seeds); retained for trace/event symmetry. */
  builtin: boolean;
}
