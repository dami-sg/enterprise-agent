import type { AgentClientTransport } from './client.js';
import { AgentClient } from './client.js';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void): void;
}

export function createWebSocketTransport(socket: WebSocketLike): AgentClientTransport {
  return {
    send: (raw) => socket.send(raw),
    close: () => socket.close(),
    onMessage: (listener) => {
      const handler = (event: unknown): void => {
        const data = (event as { data: unknown }).data;
        if (typeof data === 'string') listener(data);
        else if (data instanceof ArrayBuffer) listener(new TextDecoder().decode(data));
        else if (ArrayBuffer.isView(data)) {
          const view = data as ArrayBufferView;
          listener(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)));
        }
      };
      socket.addEventListener('message', handler);
      return () => socket.removeEventListener('message', handler);
    },
    onClose: (listener) => {
      // Either a clean close or a transport error leaves in-flight requests
      // unanswerable, so both must notify the client to reject them. `once`
      // semantics are enforced by the client (it ignores a second disconnect).
      const handler = (): void => listener();
      socket.addEventListener('close', handler);
      socket.addEventListener('error', handler);
      return () => {
        socket.removeEventListener('close', handler);
        socket.removeEventListener('error', handler);
      };
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
