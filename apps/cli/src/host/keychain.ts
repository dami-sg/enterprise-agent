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
class MacKeychain implements KeyStore {
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
    // -U updates an existing item instead of erroring on duplicate.
    execFileSync(
      'security',
      ['add-generic-password', '-a', ref, '-s', SERVICE, '-w', value, '-U'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
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
    this.cache = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>)
      : {};
    return this.cache;
  }

  private flush(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache ?? {}, null, 2));
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
