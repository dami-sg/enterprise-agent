/**
 * CSRF/Origin defense (web-app §6). The public chat server and the localhost
 * admin panel both reject a state-changing request whose browser Origin doesn't
 * match the target: a cross-site page's forged request is refused, same-origin
 * passes, and a missing Origin (non-browser client) is allowed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { originOk } from '../src/web/chat-server.js';
import { originAllowed } from '../src/web/server.js';

const req = (headers: Record<string, string | undefined>): IncomingMessage =>
  ({ headers }) as unknown as IncomingMessage;

describe('chat-server originOk', () => {
  afterEach(() => {
    delete process.env.EA_WEB_ALLOWED_ORIGINS;
  });

  it('allows a request with no Origin (non-browser client)', () => {
    expect(originOk(req({ host: 'chat.example.com' }))).toBe(true);
  });

  it('allows a same-origin request (Origin host == Host)', () => {
    expect(originOk(req({ host: 'chat.example.com', origin: 'https://chat.example.com' }))).toBe(true);
  });

  it('rejects a cross-origin request', () => {
    expect(originOk(req({ host: 'chat.example.com', origin: 'https://evil.example' }))).toBe(false);
  });

  it('honors EA_WEB_ALLOWED_ORIGINS for a TLS-fronted deploy', () => {
    process.env.EA_WEB_ALLOWED_ORIGINS = 'https://public.example, https://alt.example';
    expect(originOk(req({ host: '127.0.0.1:7318', origin: 'https://public.example' }))).toBe(true);
    expect(originOk(req({ host: '127.0.0.1:7318', origin: 'https://alt.example' }))).toBe(true);
    expect(originOk(req({ host: '127.0.0.1:7318', origin: 'https://evil.example' }))).toBe(false);
  });

  it('rejects a malformed Origin', () => {
    expect(originOk(req({ host: 'x', origin: 'not a url' }))).toBe(false);
  });
});

describe('admin server originAllowed', () => {
  it('allows a request with no Origin', () => {
    expect(originAllowed(req({ host: '127.0.0.1:7317' }))).toBe(true);
  });

  it('allows a same-origin request', () => {
    expect(originAllowed(req({ host: '127.0.0.1:7317', origin: 'http://127.0.0.1:7317' }))).toBe(true);
  });

  it('rejects a cross-origin request (a local page targeting 127.0.0.1)', () => {
    expect(originAllowed(req({ host: '127.0.0.1:7317', origin: 'http://evil.example' }))).toBe(false);
  });
});
