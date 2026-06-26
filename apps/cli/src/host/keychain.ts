/**
 * File-backed `KeyStore` (cli §7). The agent core only ever sees the `KeyStore`
 * interface and reads secrets inside its own process; the CLI supplies a
 * concrete backend so `ea auth login` can persist a provider key. The plaintext
 * lands in a 0600 `secrets.json` under the app root — `providers.json` still
 * keeps just the `keyRef` (agent §4 / cli §10).
 *
 * Note: the OS keychain backend was intentionally removed — keys are stored in
 * plaintext on disk on every platform. This is less private than a system
 * keychain (flagged via `insecure` so the host can warn), but avoids depending
 * on `security(1)` / native secret stores.
 */
import type { KeyStore } from '@enterprise-agent/agent';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Plaintext file store. Stored 0600 under the app root. Less private than a real
 * keychain — flagged so the host can warn — but keeps plaintext out of
 * `providers.json` and works identically across platforms.
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
  /** Always true — keys are stored in a plaintext file (host should warn — §10). */
  insecure: boolean;
  backend: 'file';
}

/** Build the plaintext file key store. Keys live in `<root>/secrets.json` (0600). */
export function createKeychain(root: string): KeychainInfo {
  return { store: new FileKeyStore(join(root, 'secrets.json')), insecure: true, backend: 'file' };
}
