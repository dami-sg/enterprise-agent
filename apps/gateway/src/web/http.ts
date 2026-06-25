/**
 * Tiny shared HTTP helpers for the Web tier's Node `http` handlers (web-app §4.2).
 * Both the chat and auth endpoints need to (a) read a size-capped request body and
 * (b) write a JSON response (optionally with a `Set-Cookie`); this is the single
 * copy so the cap/headers stay consistent across them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Default request-body cap. Chat messages and auth payloads are both small. */
export const DEFAULT_MAX_BODY = 1024 * 1024; // 1MB

/** Read a request body to a string, rejecting (and destroying the socket) past `limit`. */
export function readBody(req: IncomingMessage, limit: number = DEFAULT_MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Write a JSON response, optionally setting a session cookie. */
export function sendJson(res: ServerResponse, status: number, body: unknown, setCookie?: string): void {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(status, headers).end(JSON.stringify(body));
}
