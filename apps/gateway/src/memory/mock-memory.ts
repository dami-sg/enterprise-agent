/**
 * In-memory mock MemoryPort for development & integration tests
 * (cross-channel-memory §4.0). NOT a real engine — recall is recency-based
 * (newest-first), not semantic. It exists so the whole memory wiring
 * (factory → inject → capture/retrieve → governance) can be exercised before a
 * real backend (mem0 / …) is chosen. The real backend must satisfy this same
 * surface: the required MemoryPort (capture/retrieve/maintain) plus the optional
 * list/forget governance methods used by §5.4.
 *
 * Isolation (§5.1): keyed by scope (tenant + namespace) — i.e. accountId.
 * Different namespaces never see each other's records.
 */
import type {
  CapturePayload,
  MemoryHit,
  MemoryPort,
  MemoryScope,
  RetrieveOpts,
} from '@enterprise-agent/agent-contract';

export interface MemoryRecord {
  id: string;
  text: string;
  role: 'user' | 'assistant';
  createdAt: number;
}

/**
 * Optional governance capability (memory §2.2 note: id CRUD belongs on optional
 * methods a backend MAY add, never on the required MemoryPort surface). Drives
 * the "我的记忆" list/delete experience (§5.4). Backends that can't support it
 * simply don't implement it, and governance degrades.
 */
export interface GovernableMemory extends MemoryPort {
  list(scope: MemoryScope, opts?: { limit?: number }): Promise<MemoryRecord[]>;
  forget(scope: MemoryScope, id: string): Promise<boolean>;
}

function keyOf(scope: MemoryScope): string {
  return scope.tenant ? `${scope.tenant}::${scope.namespace}` : scope.namespace;
}

export class InMemoryMemory implements GovernableMemory {
  private readonly store = new Map<string, MemoryRecord[]>();
  private seq = 0;

  async capture(scope: MemoryScope, payload: CapturePayload): Promise<void> {
    const key = keyOf(scope);
    const bucket = this.store.get(key) ?? [];
    for (const m of payload.messages) {
      const text = m.text.trim();
      if (!text) continue;
      bucket.push({ id: `m${++this.seq}`, text, role: m.role, createdAt: Date.now() });
    }
    this.store.set(key, bucket);
  }

  async retrieve(scope: MemoryScope, query: string, opts?: RetrieveOpts): Promise<MemoryHit[]> {
    if (!query.trim()) return [];
    const bucket = this.store.get(keyOf(scope)) ?? [];
    const topK = opts?.topK ?? 6;
    // Recency-based recall (mock): newest-first, capped at topK. A real backend
    // ranks by semantic relevance to `query`; here we only prove the plumbing.
    return bucket
      .slice()
      .reverse()
      .slice(0, topK)
      .map((r) => ({ text: r.text, score: 1, metadata: { id: r.id, role: r.role } }));
  }

  async maintain(): Promise<void> {
    // no-op: nothing to consolidate in the mock.
  }

  async list(scope: MemoryScope, opts?: { limit?: number }): Promise<MemoryRecord[]> {
    const bucket = this.store.get(keyOf(scope)) ?? [];
    const out = bucket.slice().reverse();
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }

  async forget(scope: MemoryScope, id: string): Promise<boolean> {
    const key = keyOf(scope);
    const bucket = this.store.get(key);
    if (!bucket) return false;
    const idx = bucket.findIndex((r) => r.id === id);
    if (idx < 0) return false;
    bucket.splice(idx, 1);
    this.store.set(key, bucket);
    return true;
  }
}
