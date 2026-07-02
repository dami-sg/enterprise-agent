/**
 * Single-use replay guard for login credentials (web-app §3.2 / §6). A verified
 * Telegram Login Widget payload or OIDC `id_token` is valid for its whole freshness
 * window; without a one-shot check, anyone who observes one (proxy logs, browser
 * history, a shared link) can replay it for a fresh session until it expires. This
 * records each credential's fingerprint on first use and rejects any repeat.
 *
 * In-memory + process-scoped (like the session store's default): entries expire
 * after the credential's own max lifetime, so the map stays bounded.
 */
export class ReplayCache {
  private readonly seen = new Map<string, number>(); // fingerprint -> expiry (ms)

  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  /** Record `key` on first use; returns true if fresh, false if already consumed. */
  consume(key: string, now: number = Date.now()): boolean {
    this.evict(now);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  private evict(now: number): void {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
  }
}
