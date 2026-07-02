/**
 * Tiny HTTP helpers shared by the serve router (cli §8). Mirrors the gateway
 * web panel's zero-dependency style (apps/gateway/src/web/server.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

/** A handled-error response: `{ error }` with the given status. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Read and JSON-parse a request body; `{}` for an empty body. */
export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      data += c;
      // Serve command bodies are small JSON; cap tight and tear the socket down on
      // overflow so a client can't keep streaming into an already-rejected buffer.
      if (data.length > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        const parsed = JSON.parse(data) as unknown;
        if (parsed === null || typeof parsed !== 'object') {
          return reject(new Error('请求体必须是 JSON object'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`无效 JSON：${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}
