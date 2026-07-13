/**
 * Gateway host bootstrap (gateway §1 / §10). Reuses the CLI's `bootstrap` and
 * keychain wholesale so the gateway shares one app-data root with the CLI /
 * desktop — providers, keys, sessions and skills configured in either are seen
 * by the other (gateway §1). The gateway adds nothing to host construction; it
 * only resolves its own `gateway/` paths on top.
 */
import { execFileSync } from 'node:child_process';
import { bootstrap, createKeychain, type CliContext } from '@dami-sg/cli';
import type { AgentHost, MemoryPort } from '@dami-sg/agent-contract';
import type { KeyStore } from '@dami-sg/agent';
import { createGatewayPaths, type GatewayPaths } from '../config/paths.js';
import { createMemory, type MemoryBackend } from '../memory/index.js';

/** Matches the CLI's keychain service name (host/keychain.ts). */
const KEYCHAIN_SERVICE = 'enterprise-agent';

/**
 * Wrap a keychain so `set` is safe in a non-interactive service (gateway is
 * headless / often started from a terminal). The CLI's `MacKeychain.set` uses
 * `security add-generic-password -w` with NO value, expecting the password on
 * stdin — but `security` reads it via `getpass(/dev/tty)` when a controlling
 * terminal exists, popping a "password data for new item:" prompt and BLOCKING.
 * In the Web UI / `secret set` that deadlocks the request. Rather than pass the
 * value in argv (where it's visible in `ps` to any local user), give `security`
 * the password on a PIPED stdin: per its man page, `-w` with no argument reads
 * the password "from stdin if it is not a tty" — a pipe isn't — so it neither
 * prompts (no getpass) nor leaks the secret via argv. `get`/`delete` are
 * unaffected (they never prompt).
 */
function serviceSafeKeychain(store: KeyStore, backend: string): KeyStore {
  if (backend !== 'macos-keychain') return store; // FileKeyStore.set writes a file — no tty
  return {
    get: (ref) => store.get(ref),
    delete: (ref) => store.delete(ref),
    set: (ref, value) => {
      if (/[\r\n]/.test(value)) throw new Error('密钥不能包含换行符（macOS keychain）。');
      execFileSync(
        'security',
        ['add-generic-password', '-a', ref, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
        { input: value + '\n', stdio: ['pipe', 'ignore', 'ignore'] },
      );
    },
  };
}

export interface GatewayContext {
  host: AgentHost;
  keychain: KeyStore;
  paths: GatewayPaths;
  /** The host's memory port (cross-channel-memory §4), or undefined when the
   *  backend is 'none'. Exposed so the runtime can drive the `/memories` /
   *  `/forget` governance commands (§5.4) against the same instance. */
  memory?: MemoryPort;
  dispose(): Promise<void>;
}

/**
 * Resolve the memory backend from `EA_MEMORY_BACKEND` (cross-channel-memory
 * §4.0). Defaults to 'none' (memory off). 'mock' wires the in-memory backend so
 * cross-session recall can be exercised locally before a real engine is chosen;
 * 'mem0' is reserved and not wired yet. Note: the hooks still only fire when
 * `settings.memory.enabled` is true (the enable switch stays in config).
 */
function resolveMemoryBackend(): MemoryBackend {
  const raw = (process.env.EA_MEMORY_BACKEND ?? 'none').trim();
  if (raw === 'none' || raw === 'mock' || raw === 'mem0') return raw;
  throw new Error(`EA_MEMORY_BACKEND must be one of none|mock|mem0, got "${raw}"`);
}

/** Full context for `start` / `ui`: the in-process host + keychain + gateway paths. */
export function bootstrapGateway(root?: string): GatewayContext {
  const backend = resolveMemoryBackend();
  const memory = createMemory({ backend });
  const ctx: CliContext = bootstrap({ root, memory });
  if (backend !== 'none') console.error(`[gateway] memory backend: ${backend}`);
  return {
    host: ctx.host,
    keychain: serviceSafeKeychain(ctx.keychain, ctx.keychainInfo.backend),
    paths: createGatewayPaths(root),
    memory,
    dispose: () => ctx.dispose(),
  };
}

/** Lightweight context for `weixin login` / `secret` / `route` / `status`: no host
 *  spun up, just the keychain backend + gateway paths. */
export function keychainOnly(root?: string): {
  keychain: KeyStore;
  insecure: boolean;
  paths: GatewayPaths;
} {
  const paths = createGatewayPaths(root);
  const kc = createKeychain(paths.root);
  return { keychain: serviceSafeKeychain(kc.store, kc.backend), insecure: kc.insecure, paths };
}
