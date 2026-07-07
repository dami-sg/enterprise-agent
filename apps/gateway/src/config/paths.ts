/**
 * Gateway filesystem layout under the shared App data root `~/.enterprise-agent/`
 * (gateway §7). The gateway owns only the `gateway.json` config and a `gateway/`
 * subtree (routes + per-adapter state); everything else (sessions, providers,
 * keychain) is the same on-disk truth the CLI / desktop see (gateway §1).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GatewayPaths {
  root: string;
  /** Channel config (incl. reset / privilege), gateway §7. */
  gatewayConfig: string;
  /** `channel:conversationId → sessionId` routing table (§4.1). */
  routes: string;
  /** Per-adapter account state dir, e.g. iLink cursor (§8.5). */
  accountsDir(channel: string): string;
  /** Adapter state file, e.g. `gateway/weixin/accounts/<id>.json` (§8.5). */
  accountState(channel: string, accountId: string): string;
  /** Per-conversation context tokens, e.g. WeChat `context_token` (§8.5). */
  contextTokens(channel: string, accountId: string): string;
  /** Account + cross-channel identity stores dir (`gateway/identity/`,
   *  cross-channel-memory §3 / web-app §3): accounts.json, identities.json,
   *  link-pending.json. */
  identityDir: string;
  /** Running gateway's PID record (`gateway/gateway.pid`), for panel start/stop (§7). */
  pidFile: string;
  /** Gateway process log (`gateway/gateway.log`), tailed by the panel for errors (§7). */
  logFile: string;
  /** Admin login secret file (`gateway/admin-secret`, 0600), shared by the control
   *  plane (panel) and data plane (gateway-consolidation §4.4 / §7-B/E). */
  adminSecret: string;
}

export function createGatewayPaths(root?: string): GatewayPaths {
  const base = root ?? process.env.ENTERPRISE_AGENT_HOME ?? join(homedir(), '.enterprise-agent');
  const gw = join(base, 'gateway');
  return {
    root: base,
    gatewayConfig: join(base, 'gateway.json'),
    routes: join(gw, 'routes.json'),
    accountsDir: (channel) => join(gw, channel, 'accounts'),
    accountState: (channel, accountId) => join(gw, channel, 'accounts', `${accountId}.json`),
    contextTokens: (channel, accountId) =>
      join(gw, channel, 'accounts', `${accountId}.context-tokens.json`),
    identityDir: join(gw, 'identity'),
    pidFile: join(gw, 'gateway.pid'),
    logFile: join(gw, 'gateway.log'),
    adminSecret: join(gw, 'admin-secret'),
  };
}
