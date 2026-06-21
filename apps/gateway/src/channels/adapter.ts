/**
 * Channel abstraction (gateway §3). Every platform implements exactly this one
 * interface; the Runtime / Router / Dispatcher are entirely platform-agnostic.
 * Weak-capability platforms degrade by simply *not implementing* the optional
 * methods (`edit` / `typing`) or via `supportsButtons=false` — the Runtime never branches on
 * platform (gateway §3.3). WeChat (no edit / no buttons / DM-only, §8) is the
 * stress test for that principle.
 */

/** A decrypted inbound/outbound media item (gateway §3.2). */
export interface Attachment {
  kind: 'image' | 'audio' | 'file' | 'video';
  /** Decrypted bytes (inbound) or bytes to upload (outbound), when in-memory. */
  data?: Buffer;
  /** Remote URL when the bytes aren't materialized. */
  url?: string;
  filename?: string;
  mimeType?: string;
  caption?: string;
}

/**
 * Normalized inbound message (gateway §3.2). `conversationId` is the Router key
 * (§4.1); `userId` drives auth / admin partitioning (§6.4). A platform button
 * click arrives as an inbound with `callbackData` set (and usually empty text).
 */
export interface InboundMessage {
  channel: string;
  conversationId: string;
  userId: string;
  text: string;
  attachments?: Attachment[];
  /** Set when this inbound is an interactive-button click, not a typed message.
   *  The Dispatcher resolves it against its pending-token registry (§6.1). */
  callbackData?: string;
  /** Platform-specific ack handle for a callback (e.g. Telegram callback_query id). */
  callbackAckId?: string;
  /** Platform raw object (e.g. WeChat `context_token`, §8) the adapter stashes
   *  so out-bound replies land in the right conversation window. */
  raw?: unknown;
}

/** Where to send (gateway §3). `raw` carries per-conversation opaque routing
 *  state the adapter needs — e.g. WeChat's `context_token` (§8.5). */
export interface SendTarget {
  conversationId: string;
  raw?: unknown;
}

/** A tappable choice rendered as an inline button (approval / question / plan). */
export interface Button {
  /** Opaque id echoed back as `InboundMessage.callbackData` when tapped. */
  id: string;
  label: string;
}

/** Outbound payload (gateway §3.2). */
export type OutboundPayload =
  | { kind: 'text'; text: string }
  | { kind: 'media'; media: Attachment; caption?: string }
  | { kind: 'buttons'; text: string; buttons: Button[] };

/** Handle to a sent message, for streaming edits (gateway §5). */
export interface MessageRef {
  conversationId: string;
  messageId: string;
}

/** An approval to render in-chat (gateway §6.1, inline-button path). */
export interface ChannelAdapter {
  readonly name: string;
  /** Per-message character cap (gateway §5 splitting). Telegram 4096 / WeChat 4000. */
  readonly maxChars: number;
  /**
   * Whether the platform can render tappable inline buttons (gateway §6.1). True
   * → approval / question / plan render as a button card whose taps come back as
   * `InboundMessage.callbackData`. False → those fall to `/approve` text or auto.
   */
  readonly supportsButtons: boolean;
  /** Begin receiving (long-poll or webhook). Resolves once polling is live. */
  start(onInbound: (m: InboundMessage) => void): Promise<void>;
  send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef>;
  /** Streaming / in-place edit; absent → ChatRenderer degrades to whole-message send (§5). */
  edit?(ref: MessageRef, payload: OutboundPayload): Promise<void>;
  /** "typing…" indicator; absent → no-op. */
  typing?(target: SendTarget, on: boolean): Promise<void>;
  stop(): Promise<void>;
}

/** The subset of a `ChannelAdapter` the ChatRenderer needs (gateway §5). */
export interface OutboundChannel {
  readonly maxChars: number;
  send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef>;
  edit?(ref: MessageRef, payload: OutboundPayload): Promise<void>;
  typing?(target: SendTarget, on: boolean): Promise<void>;
}
