/**
 * Secret store (agent §4): API keys / tokens are referenced by `keyRef`, never
 * stored in plaintext config. The concrete backend (OS keychain via
 * safeStorage/keytar) is supplied by the host; the core only sees this
 * interface, and reads secrets exclusively inside the utilityProcess.
 */
export interface KeyStore {
  get(ref: string): string | undefined;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}

/**
 * Default in-process keystore. Reads from `ENTERPRISE_AGENT_KEY_<REF>` env vars and an
 * in-memory map. Hosts should replace this with an OS-keychain-backed impl.
 */
export class EnvKeyStore implements KeyStore {
  private readonly mem = new Map<string, string>();

  get(ref: string): string | undefined {
    if (this.mem.has(ref)) return this.mem.get(ref);
    const envKey = `ENTERPRISE_AGENT_KEY_${ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
    return process.env[envKey];
  }

  set(ref: string, value: string): void {
    this.mem.set(ref, value);
  }

  delete(ref: string): void {
    this.mem.delete(ref);
  }
}
