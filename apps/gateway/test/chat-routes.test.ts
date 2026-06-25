/**
 * Web chat route matcher (web-app §4.2): method+path dispatch, path-param
 * extraction, method gating (405) and unknown paths (404).
 */
import { describe, it, expect } from 'vitest';
import { matchWebRoute } from '../src/web/chat-routes.js';

it('routes POST /api/chat', () => {
  expect(matchWebRoute('POST', '/api/chat')).toEqual({ route: 'chat' });
  expect(matchWebRoute('GET', '/api/chat')).toEqual({ route: 'method-not-allowed' });
});

it('routes POST /api/respond', () => {
  expect(matchWebRoute('POST', '/api/respond')).toEqual({ route: 'respond' });
  expect(matchWebRoute('GET', '/api/respond')).toEqual({ route: 'method-not-allowed' });
});

it('routes GET /api/sessions and GET /api/models', () => {
  expect(matchWebRoute('GET', '/api/sessions')).toEqual({ route: 'sessions' });
  expect(matchWebRoute('DELETE', '/api/sessions')).toEqual({ route: 'method-not-allowed' });
  expect(matchWebRoute('GET', '/api/models')).toEqual({ route: 'models' });
  expect(matchWebRoute('POST', '/api/models')).toEqual({ route: 'method-not-allowed' });
});

it('routes GET /api/session/:id/history and extracts the id', () => {
  expect(matchWebRoute('GET', '/api/session/s123/history')).toEqual({ route: 'history', sessionId: 's123' });
  expect(matchWebRoute('GET', '/api/session/abc%2Fdef/history')).toEqual({ route: 'history', sessionId: 'abc/def' });
  expect(matchWebRoute('POST', '/api/session/s1/history')).toEqual({ route: 'method-not-allowed' });
});

it('tolerates a trailing slash', () => {
  expect(matchWebRoute('POST', '/api/chat/')).toEqual({ route: 'chat' });
});

it('routes POST /api/session/:id/rename and DELETE /api/session/:id', () => {
  expect(matchWebRoute('POST', '/api/session/s1/rename')).toEqual({ route: 'rename', sessionId: 's1' });
  expect(matchWebRoute('GET', '/api/session/s1/rename')).toEqual({ route: 'method-not-allowed' });
  expect(matchWebRoute('DELETE', '/api/session/s1')).toEqual({ route: 'delete', sessionId: 's1' });
  expect(matchWebRoute('GET', '/api/session/s1')).toEqual({ route: 'method-not-allowed' });
});

it('routes the auth endpoints (W1c)', () => {
  expect(matchWebRoute('POST', '/api/auth/telegram')).toEqual({ route: 'auth-telegram' });
  expect(matchWebRoute('POST', '/api/auth/google/mock')).toEqual({ route: 'auth-google-mock' });
  expect(matchWebRoute('POST', '/api/auth/logout')).toEqual({ route: 'auth-logout' });
  expect(matchWebRoute('GET', '/api/auth/me')).toEqual({ route: 'auth-me' });
  expect(matchWebRoute('GET', '/api/auth/config')).toEqual({ route: 'auth-config' });
  expect(matchWebRoute('GET', '/api/auth/telegram')).toEqual({ route: 'method-not-allowed' });
});

it('returns not-found for unknown paths', () => {
  expect(matchWebRoute('GET', '/api/nope')).toEqual({ route: 'not-found' });
  expect(matchWebRoute('GET', '/')).toEqual({ route: 'not-found' });
});
