/**
 * SSRF egress guard for the network tool (agent §4). The model — or content it
 * ingests — can drive `httpFetch` at arbitrary URLs, so before any outbound
 * request we (1) allow only http/https, (2) resolve the hostname and reject any
 * loopback / link-local / private / cloud-metadata address, and (3) re-run both
 * checks on every redirect hop. This blocks the metadata-endpoint credential
 * theft, internal-service scans, and redirect-based pivots the host allowlist
 * alone does not stop.
 *
 * Residual risk: a hostname that resolves to a public IP at check time and a
 * private IP at connect time (DNS rebinding) is not fully closed here — Node's
 * `fetch` doesn't expose connect-time IP pinning. The OS sandbox and network
 * policy remain the hard floor for that case.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Resolve a hostname to its addresses. Overridable as a test seam so unit tests
 *  don't depend on live DNS; production always uses the real resolver. */
export type LookupFn = (host: string) => Promise<Array<{ address: string }>>;
const defaultLookup: LookupFn = (host) => lookup(host, { all: true });
let currentLookup: LookupFn = defaultLookup;
export function setSsrfLookup(fn: LookupFn | undefined): void {
  currentLookup = fn ?? defaultLookup;
}

function ipv4Blocked(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 127) return true; // this-host / loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64.0.0/10)
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
  return false;
}

function ipv6Blocked(raw: string): boolean {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped/compat (::ffff:a.b.c.d) — validate the embedded v4.
  const mapped = ip.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (ip === '::' || ip === '::1') return true; // unspecified / loopback
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb'))
    return true; // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique-local fc00::/7
  return false;
}

function addressBlocked(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true; // not a recognizable address → refuse
}

/**
 * Validate a single URL: scheme + resolved-IP checks. Throws {@link SsrfError} on
 * a disallowed scheme or an address that resolves into a blocked range.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError('invalid_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfError(`scheme '${parsed.protocol}' not allowed`);
  }
  const host = parsed.hostname;
  // Resolve every A/AAAA record; a hostname that maps to ANY blocked address is
  // refused (a split-horizon or extra internal record can't sneak through).
  let addrs: Array<{ address: string }>;
  if (isIP(host)) {
    addrs = [{ address: host.replace(/^\[|\]$/g, '') }];
  } else {
    try {
      addrs = await currentLookup(host);
    } catch {
      throw new SsrfError(`cannot resolve host '${host}'`);
    }
  }
  for (const { address } of addrs) {
    if (addressBlocked(address)) {
      throw new SsrfError(`host '${host}' resolves to a blocked address (${address})`);
    }
  }
}

export interface SafeFetchOptions {
  maxHops?: number;
  /**
   * Application-layer egress allowlist, re-checked on EVERY hop. The SSRF guard
   * only blocks private/metadata IP ranges; without this an allowlisted host
   * could 302 to an arbitrary *public* host (open-redirect exfiltration) that the
   * operator never allowlisted and the user never approved. Returns false → the
   * hop is refused. Omit to allow any host the SSRF guard permits.
   */
  isHostAllowed?: (hostname: string) => boolean;
}

/**
 * `fetch` with SSRF validation on the initial URL and every redirect hop. Uses
 * manual redirect handling so each `Location` is re-checked (an allowlisted host
 * can still 302 to the metadata endpoint). Caps hops to avoid loops.
 */
export async function safeFetch(url: string, init: RequestInit, opts: SafeFetchOptions = {}): Promise<Response> {
  const { maxHops = 5, isHostAllowed } = opts;
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    if (isHostAllowed) {
      const hostname = new URL(current).hostname;
      if (!isHostAllowed(hostname)) {
        throw new SsrfError(`host '${hostname}' is not in the egress allowlist`);
      }
    }
    await assertSafeUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res; // redirect with no target — hand back as-is
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfError('too many redirects');
}
