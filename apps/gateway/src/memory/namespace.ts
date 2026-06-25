/**
 * Memory namespace policy (cross-channel-memory §3). Decides the per-session
 * memory namespace from channel identity, consuming the account layer's
 * `resolveAccount` (web-app §3.4). The isolation invariant (§5.1): memory exists
 * ONLY for a bound account — group chats and unbound/anonymous users get
 * `undefined`, so the session attaches no memory at all (never the shared
 * 'default' pool, which would leak across users).
 *
 * `channel` is used as the identity `provider` (web-app §3.1: provider name ==
 * channel name; providerUserId == inbound userId).
 */

export type ResolveAccount = (provider: string, providerUserId: string) => string | undefined;

export interface NamespaceInput {
  channel: string;
  /** Inbound userId (e.g. Telegram from.id). */
  userId: string;
  /** Whether this is a 1:1 private chat. Group chats never enter memory (§5.3). */
  isPrivate: boolean;
}

/**
 * Resolve the memory namespace for a session, or `undefined` to attach no
 * memory. Bound private chat → the accountId; group or unbound → undefined.
 */
export function resolveNamespace(resolve: ResolveAccount, input: NamespaceInput): string | undefined {
  if (!input.isPrivate) return undefined; // group → no memory (§5.3)
  return resolve(input.channel, input.userId) ?? undefined; // bound → accountId; else no memory
}
