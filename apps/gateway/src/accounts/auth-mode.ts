/**
 * Gateway run mode (gateway-consolidation §4.1). A deployment-wide policy that
 * decides whether clients must present a per-user access key:
 *
 *   - `open`    —免 key。Local-dev posture; only sound when reachable solely from
 *                 loopback. Derived automatically when a surface binds loopback.
 *   - `managed` — every client must authenticate (cookie or Bearer key). Derived
 *                 automatically when a surface binds a non-loopback address.
 *
 * The default follows the bind address (decision §7-A: default `open`, auto-switch
 * to `managed` off loopback). `EA_GATEWAY_AUTH_MODE=open|managed` forces a value,
 * e.g. to lock down a loopback deployment or to test `managed` locally.
 *
 * Kept pure and dependency-free so both the `/rpc` surface and the IM ingress
 * gate resolve the mode the same way.
 */
export type AuthMode = 'open' | 'managed';

/** True for loopback bind targets (or an unset host, which defaults to 127.0.0.1). */
export function isLoopbackHost(host: string | undefined): boolean {
  const h = (host ?? '127.0.0.1').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** True for a loopback *peer* address (as seen on a socket's `remoteAddress`). */
export function isLoopbackPeer(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Resolve the run mode. `EA_GATEWAY_AUTH_MODE` wins if set to a valid value;
 * otherwise `open` on a loopback bind, `managed` otherwise.
 */
export function resolveAuthMode(host?: string): AuthMode {
  const override = process.env.EA_GATEWAY_AUTH_MODE?.trim();
  if (override === 'open' || override === 'managed') return override;
  return isLoopbackHost(host) ? 'open' : 'managed';
}
