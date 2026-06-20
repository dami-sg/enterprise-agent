/**
 * OS-keychain-backed `KeyStore` (cli §7). The agent core only ever sees the
 * `KeyStore` interface and reads secrets inside its own process; the CLI
 * supplies a concrete backend so `ea auth login` can persist a provider key
 * with the plaintext landing **only** in the OS keychain — `providers.json`
 * keeps just the `keyRef` (agent §4 / cli §10).
 *
 * Backends, in order of preference:
 *   - macOS  → the `security` generic-password store (`security(1)`).
 *   - other  → a 0600 file under the app root (documented fallback; no native
 *              secret store is bundled without Electron `safeStorage`/keytar).
 */
import type { KeyStore } from '@enterprise-agent/agent';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVICE = 'enterprise-agent';

/** macOS `security` generic-password store. Synchronous, matches `KeyStore`. */
export class MacKeychain implements KeyStore {
  get(ref: string): string | undefined {
    try {
      const out = execFileSync(
        'security',
        ['find-generic-password', '-a', ref, '-s', SERVICE, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return out.replace(/\n$/, '');
    } catch {
      return undefined; // not found
    }
  }

  set(ref: string, value: string): void {
    // Keep the plaintext key out of argv: `security add-generic-password -w
    // <value>` would expose it to any local process via `ps`/argv inspection
    // for the lifetime of the (synchronous) child. Instead use Apple's
    // recommended "prompt" form — `-w` with no value — which reads the password
    // from stdin. `security` asks twice (enter + confirm), so the value is piped
    // twice; argv carries only flags. `-U` keeps the upsert semantics.
    //
    // The prompt is line-oriented: a value with an embedded newline would be
    // split across the two reads and silently truncated/mismatched. Provider
    // keys are single-line (`readSecret` consumes one line), so reject newlines
    // rather than write a corrupted secret. (`-X` hex input is no fix — the hex
    // string still lands in argv, trivially reversible.)
    if (/[\r\n]/.test(value)) {
      throw new Error('密钥不能包含换行符（macOS keychain）。');
    }
    execFileSync(
      'security',
      ['add-generic-password', '-a', ref, '-s', SERVICE, '-U', '-w'],
      { input: `${value}\n${value}\n`, stdio: ['pipe', 'ignore', 'ignore'] },
    );
  }

  delete(ref: string): void {
    try {
      execFileSync('security', ['delete-generic-password', '-a', ref, '-s', SERVICE], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      /* already absent */
    }
  }
}

/**
 * Fallback file store for platforms without a wired-up native keychain. Stored
 * 0600 under the app root. Less private than a real keychain — flagged so the
 * host can warn — but still keeps plaintext out of `providers.json`.
 */
class FileKeyStore implements KeyStore {
  readonly insecure = true;
  private cache: Record<string, string> | undefined;

  constructor(private readonly file: string) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = {};
      return this.cache;
    }
    // A corrupt store must surface, not be silently treated as empty: doing so
    // would make the next `set` overwrite the file and destroy every other key.
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch (err) {
      throw new Error(`密钥库已损坏（${this.file}）：${(err as Error).message}。请修复或删除该文件后重试。`);
    }
    return this.cache;
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    // Create the file already restricted to 0600 — a separate post-write chmod
    // leaves a window where the freshly-created file (default umask, often 0644)
    // exposes the plaintext keys to other local users. `mode` is honoured on
    // creation; chmod still narrows a pre-existing file written before this.
    writeFileSync(this.file, JSON.stringify(this.cache ?? {}, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }

  get(ref: string): string | undefined {
    return this.load()[ref];
  }

  set(ref: string, value: string): void {
    this.load()[ref] = value;
    this.flush();
  }

  delete(ref: string): void {
    delete this.load()[ref];
    this.flush();
  }
}

export interface KeychainInfo {
  store: KeyStore;
  /** True when we fell back to the file store (host should warn — §10). */
  insecure: boolean;
  backend: 'macos-keychain' | 'file';
}

/** Pick the best available keychain backend for this platform. */
export function createKeychain(root: string): KeychainInfo {
  if (process.platform === 'darwin' && hasSecurityCli()) {
    return { store: new MacKeychain(), insecure: false, backend: 'macos-keychain' };
  }
  return { store: new FileKeyStore(join(root, 'secrets.json')), insecure: true, backend: 'file' };
}

function hasSecurityCli(): boolean {
  try {
    execFileSync('security', ['help'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}
