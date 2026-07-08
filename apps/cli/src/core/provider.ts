/**
 * Provider helpers for the headless commands (commands/provider) and the TUI
 * config tabs (tui-otui/views). The keychain-ref scheme (§10) and the "local
 * endpoint needs no key" rule (agent §2.6) now live in the shared contract
 * (`@enterprise-agent/agent-contract`) so they can't drift across CLI, gateway,
 * and the core model catalog. Re-exported here to keep the CLI's import surface
 * stable.
 */
import { providerKeyRef } from '@enterprise-agent/agent-contract';

export { isLocalBase } from '@enterprise-agent/agent-contract';

/** The keychain ref a provider's API key is stored under (§10). Alias of the
 *  shared `providerKeyRef`, kept for the CLI's existing call sites. */
export function keyRefFor(id: string): string {
  return providerKeyRef(id);
}
