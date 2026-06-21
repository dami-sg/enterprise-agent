/**
 * Cross-session memory capability (memory §2). A backend-agnostic semantic
 * contract: capture facts after a turn, retrieve relevant snippets before a
 * turn, maintain/consolidate in the background. The core depends ONLY on this
 * port (memory §1); concrete engines (mem0 / cognee / local files …) are
 * implementations behind it.
 *
 * The three methods are the minimal common denominator every backend can
 * implement. Backend-specific extras (id CRUD, structured/graph retrieval,
 * explicit consolidation) belong on OPTIONAL capability methods a backend MAY
 * add (memory §2.2 note) — never on this required surface. Two semantic rules
 * keep the contract from silently binding to one engine (memory §2.2):
 *   1. `retrieve` only ever returns `MemoryHit` (text + score + opaque metadata),
 *      never a backend's native object.
 *   2. `capture` is not assumed to produce a retrievable result synchronously.
 */

/**
 * Where a memory lives. `namespace` is the isolation key the host supplies
 * (memory §4): a user id, conversation id, project slug, or "global".
 */
export interface MemoryScope {
  namespace: string;
  /** Optional partition above the namespace (e.g. IM platform / group). */
  tenant?: string;
  tags?: string[];
}

/**
 * One turn message handed to `capture`. Kept provider-agnostic (no `ai` types)
 * so the contract package stays zero-dependency.
 */
export interface MemoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface CapturePayload {
  messages: MemoryMessage[];
  /** Opaque backend hints; core/host never interpret these (memory §2.2). */
  hints?: Record<string, unknown>;
}

export interface RetrieveOpts {
  topK?: number;
  /** Opaque backend hints; core/host never interpret these (memory §2.2). */
  hints?: Record<string, unknown>;
}

/**
 * A retrieved memory. The contract only ever promises text + score + an opaque
 * metadata bag — NEVER a backend's native object (memory §2.2 rule 1).
 */
export interface MemoryHit {
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryPort {
  /**
   * After a turn: feed raw messages/facts; the backend decides how to extract
   * (sync extraction, or just ingest and build later — memory §2.2 rule 2).
   * Treated as fire-and-forget by the core (memory §3 hook ②); a rejection
   * must never break the turn.
   */
  capture(scope: MemoryScope, payload: CapturePayload): Promise<void>;
  /** Before a turn: relevant snippets for `query` under `scope` (memory §3 hook ①). */
  retrieve(scope: MemoryScope, query: string, opts?: RetrieveOpts): Promise<MemoryHit[]>;
  /**
   * Background maintenance/consolidation (memory §3 hook ③). Phase-1 wiring only
   * exposes a no-op-safe call point; trigger scheduling is out of scope.
   */
  maintain(scope?: MemoryScope): Promise<void>;
}

/**
 * How the core derives `MemoryScope.namespace` when the host supplies none
 * explicitly (memory §4). The decision itself is Phase 0.
 */
export type MemoryScopeMode = 'global' | 'per-project' | 'per-user';

/**
 * `settings.memory` (memory §5). Minimal Phase-1 surface; a concrete backend
 * and its own config arrive in a later phase.
 */
export interface MemorySettings {
  /** Master switch; when off (default) all three hooks are no-ops (memory §1). */
  enabled?: boolean;
  /** Namespace derivation when the host supplies none (memory §4). Default 'per-user'. */
  scope?: MemoryScopeMode;
  retrieve?: {
    /** Max snippets to inject per turn. Default 6. */
    topK?: number;
    /** Retrieve budget (ms); on timeout the hook fails open (memory §3). Default 1500. */
    timeoutMs?: number;
  };
}
