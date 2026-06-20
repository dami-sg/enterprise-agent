/**
 * Provider helpers shared by the headless commands (commands/provider) and the
 * TUI config tabs (tui-otui/views), so the keychain-ref scheme (§10) and the
 * "local endpoint needs no key" rule (agent §2.6) live in exactly one place and
 * can't drift between the two surfaces. Pure (only the `URL` global) — safe in
 * both the Node and the OpenTUI build graphs.
 */

/** The keychain ref a provider's API key is stored under (§10): only this ref —
 *  never the plaintext — is persisted to `providers.json`. */
export function keyRefFor(id: string): string {
  return `${id}.key`;
}

/** A baseURL pointing at localhost needs no key (agent §2.6 discovery table). */
export function isLocalBase(baseURL?: string): boolean {
  if (!baseURL) return false;
  try {
    // `URL.hostname` keeps the brackets around an IPv6 literal (`[::1]`), so a
    // bare `=== '::1'` never matched — strip them before comparing.
    const h = new URL(baseURL).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}
