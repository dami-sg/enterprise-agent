import type { AgentClientTransport } from './client.js';
import { AgentClient } from './client.js';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export function createWebSocketTransport(socket: WebSocketLike): AgentClientTransport {
  return {
    send: (raw) => socket.send(raw),
    close: () => socket.close(),
    onMessage: (listener) => {
      const handler = (event: { data: unknown }): void => {
        if (typeof event.data === 'string') listener(event.data);
        else if (event.data instanceof ArrayBuffer) listener(new TextDecoder().decode(event.data));
        else if (ArrayBuffer.isView(event.data)) {
          const view = event.data;
          listener(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
        }
      };
      socket.addEventListener('message', handler);
      return () => socket.removeEventListener('message', handler);
    },
  };
}

export interface ConnectWebSocketClientOptions {
  url: string | URL;
  WebSocketCtor?: new (url: string) => WebSocketLike;
}

export function connectWebSocketAgentClient(opts: ConnectWebSocketClientOptions): AgentClient {
  const Ctor = opts.WebSocketCtor ?? (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is not available in this runtime');
  const socket = new Ctor(String(opts.url));
  return new AgentClient({ transport: createWebSocketTransport(socket) });
}
