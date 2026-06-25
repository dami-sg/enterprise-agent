/**
 * Web chat HTTP route matcher (web-app §4.2). Pure method+path → route mapping,
 * separated from the server so it's unit-testable. Routes:
 *   POST /api/chat                      → stream a turn
 *   POST /api/respond                   → resolve a pending approval/question/plan
 *   GET  /api/sessions                  → the account's conversation list
 *   GET  /api/session/:id/history       → a session's transcript
 */
export type WebRouteMatch =
  | { route: 'chat' }
  | { route: 'respond' }
  | { route: 'sessions' }
  | { route: 'models' }
  | { route: 'history'; sessionId: string }
  | { route: 'rename'; sessionId: string }
  | { route: 'delete'; sessionId: string }
  | { route: 'auth-telegram' }
  | { route: 'auth-google-mock' }
  | { route: 'auth-logout' }
  | { route: 'auth-me' }
  | { route: 'auth-config' }
  | { route: 'method-not-allowed' }
  | { route: 'not-found' };

const HISTORY_RE = /^\/api\/session\/([^/]+)\/history$/;
const RENAME_RE = /^\/api\/session\/([^/]+)\/rename$/;
const SESSION_RE = /^\/api\/session\/([^/]+)$/;

export function matchWebRoute(method: string, pathname: string): WebRouteMatch {
  const p = pathname.replace(/\/+$/, '') || '/'; // tolerate a trailing slash

  if (p === '/api/chat') return method === 'POST' ? { route: 'chat' } : { route: 'method-not-allowed' };
  if (p === '/api/respond') return method === 'POST' ? { route: 'respond' } : { route: 'method-not-allowed' };
  if (p === '/api/sessions') return method === 'GET' ? { route: 'sessions' } : { route: 'method-not-allowed' };
  if (p === '/api/models') return method === 'GET' ? { route: 'models' } : { route: 'method-not-allowed' };
  if (p === '/api/auth/telegram') return method === 'POST' ? { route: 'auth-telegram' } : { route: 'method-not-allowed' };
  if (p === '/api/auth/google/mock') return method === 'POST' ? { route: 'auth-google-mock' } : { route: 'method-not-allowed' };
  if (p === '/api/auth/logout') return method === 'POST' ? { route: 'auth-logout' } : { route: 'method-not-allowed' };
  if (p === '/api/auth/me') return method === 'GET' ? { route: 'auth-me' } : { route: 'method-not-allowed' };
  if (p === '/api/auth/config') return method === 'GET' ? { route: 'auth-config' } : { route: 'method-not-allowed' };

  const h = HISTORY_RE.exec(p);
  if (h) return method === 'GET' ? { route: 'history', sessionId: decodeURIComponent(h[1]!) } : { route: 'method-not-allowed' };

  const r = RENAME_RE.exec(p);
  if (r) return method === 'POST' ? { route: 'rename', sessionId: decodeURIComponent(r[1]!) } : { route: 'method-not-allowed' };

  const d = SESSION_RE.exec(p);
  if (d) return method === 'DELETE' ? { route: 'delete', sessionId: decodeURIComponent(d[1]!) } : { route: 'method-not-allowed' };

  return { route: 'not-found' };
}
