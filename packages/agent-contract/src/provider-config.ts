/**
 * Provider configuration conventions — the single source of truth shared by
 * every host (cli/core/provider, gateway/web/admin) and the core model catalog
 * (agent/models/catalog). Previously each of these carried its own copy, and
 * the catalog copy had already drifted (regex form, and it matched `0.0.0.0`
 * while the host copies did not). Centralising here kills that drift class.
 *
 * Pure — only the `URL` global, zero runtime dependencies — so it stays safe in
 * the Node, OpenTUI, and renderer/preload build graphs.
 */

/** The keychain ref a provider's API key is stored under (§10): only this ref —
 *  never the plaintext — is persisted to `providers.json`. */
export function providerKeyRef(id: string): string {
  return `${id}.key`;
}

/**
 * A baseURL pointing at a local/loopback endpoint needs no API key
 * (agent §2.6 discovery table). `0.0.0.0` is included because, as a *connect*
 * target, local dev servers (e.g. Ollama) commonly bind it.
 *
 * NOTE: this is the *connect-side* "is this endpoint local, so skip the key"
 * question. It is deliberately distinct from the *bind-side* security check
 * `isLoopbackHost` (gateway accounts/auth-mode), which EXCLUDES `0.0.0.0`
 * because binding it exposes the server on all interfaces. Do not merge them.
 */
export function isLocalBase(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    // `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`), so a
    // bare `=== '::1'` never matched — strip them before comparing.
    const h = new URL(baseURL).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}
