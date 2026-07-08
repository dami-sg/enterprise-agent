/**
 * Config-panel request guards (gateway §7 / gateway-consolidation §P3c): the
 * same-origin CSRF check on mutations. The Host-header anti-DNS-rebinding guard
 * (`hostHeaderAllowed`) is covered in app-rpc-auth.test.ts; this restores the
 * `originAllowed` coverage the deleted csrf-origin.test.ts used to provide.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { originAllowed } from '../src/web/server.js';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('panel originAllowed (CSRF same-origin gate)', () => {
  it('allows a request with no Origin (non-browser client like curl)', () => {
    expect(originAllowed(req({ host: '127.0.0.1:7317' }))).toBe(true);
  });
  it('allows a same-origin browser request (Origin host === Host)', () => {
    expect(originAllowed(req({ origin: 'http://127.0.0.1:7317', host: '127.0.0.1:7317' }))).toBe(true);
  });
  it('rejects a cross-site Origin even when the Host header passes', () => {
    expect(originAllowed(req({ origin: 'http://evil.tld', host: '127.0.0.1:7317' }))).toBe(false);
  });
  it('rejects a malformed Origin', () => {
    expect(originAllowed(req({ origin: 'not a url', host: '127.0.0.1:7317' }))).toBe(false);
  });
});
