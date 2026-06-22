/**
 * Channel abstraction (gateway §3). Every platform implements exactly this one
 * interface; the Runtime / Router / Dispatcher are entirely platform-agnostic.
 * Weak-capability platforms degrade by simply *not implementing* the optional
 * methods (`format` / `prompt` / `resolvePrompt` / `edit` / `typing`) — the Runtime
 * never branches on platform (gateway §3.3). WeChat (no edit / no prompt / DM-only,
 * §8) is the stress test for that principle.
 */

/** A decrypted inbound/outbound media item (gateway §3.2). */
export interface Attachment {
  kind: 'image' | 'audio' | 'file' | 'video';
  /** This `audio` is a voice note — the message itself, to transcribe via STT
   *  (multimodal §7) — not a shared audio file (which is saved, Route C §8). */
  voice?: boolean;
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

/**
 * A semantic interactive request — approval / question / plan (gateway §6.1/§6.3) —
 * for a channel to render in its richest native affordance. `kind` lets a rich
 * channel pick the best control (yes/no buttons, a poll, Block Kit, reactions);
 * each `choice.id` comes back as `InboundMessage.callbackData` when selected, and
 * the Dispatcher resolves it against its pending-token registry. A channel WITHOUT
 * a `prompt` method degrades to a numbered text prompt + `/approve` reply (the
 * universal floor) — the Runtime never branches on platform (gateway §3.3).
 */
export interface Prompt {
  kind: 'approval' | 'question' | 'plan';
  /** Header / body above the choices (Markdown; the adapter's `format` applies). */
  text: string;
  choices: Button[];
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

/** A mid-turn rich-message draft (gateway §5, Telegram drafts). */
export interface DraftContent {
  /** Phase label shown in the `<tg-thinking>` block (e.g. "Thinking…", "Tool
   *  calling", "Sub Agent running"). Empty → the default "Thinking…". The block
   *  is only valid in a draft, never a persisted message. */
  status?: string;
}

/** An approval to render in-chat (gateway §6.1, inline-button path). */
export interface ChannelAdapter {
  readonly name: string;
  /** Per-message character cap (gateway §5 splitting). Telegram 4096 / WeChat 4000. */
  readonly maxChars: number;
  /**
   * The platform's Markdown→text transform (gateway §5). core emits Markdown; a
   * platform that wants a different surface declares it here (e.g. WeChat → plain
   * text). This is the ONE canonical place a channel declares that transform; the
   * adapter applies it at its own transport boundary — i.e. per already-split chunk
   * inside `send` / `edit`, AFTER the shared layer split the source Markdown — so a
   * structure-based format never gets cut mid-construct. Must be pure: no network,
   * no `parse_mode` — those transport concerns stay in `send` / `edit`. Absent →
   * identity, which is exactly right for Telegram (rich messages take GFM as-is).
   */
  format?(markdown: string): string;
  /**
   * Render an interactive prompt (approval / question / plan, gateway §6.1) in the
   * platform's richest native affordance — inline buttons, quick replies, a poll,
   * Block Kit, … — mapping each `choice.id` to a tap that returns as
   * `InboundMessage.callbackData`. Absent → the Dispatcher degrades to a numbered
   * text prompt + `/approve` reply (the universal floor), so a channel implements
   * this only when it has a richer control. Capability = presence of this method
   * (like `edit` / `typing`); it replaces the old `supportsButtons` boolean.
   */
  prompt?(target: SendTarget, p: Prompt): Promise<MessageRef>;
  /**
   * Finalize a resolved prompt (gateway §6.1): a choice arrived, so retract the
   * affordance and show the outcome. `finalText` is the prompt body plus the
   * decision. Absent → the Dispatcher edits the message in place (when `edit`) or
   * replies — covering inline-button channels for free; implement only when
   * "resolve" means something native (close a poll, clear reactions).
   */
  resolvePrompt?(ref: MessageRef, finalText: string): Promise<void>;
  /** Begin receiving (long-poll or webhook). Resolves once polling is live. */
  start(onInbound: (m: InboundMessage) => void): Promise<void>;
  send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef>;
  /** Streaming / in-place edit; absent → ChatRenderer degrades to whole-message send (§5). */
  edit?(ref: MessageRef, payload: OutboundPayload): Promise<void>;
  /**
   * Show a mid-turn rich draft while the agent works (gateway §5, Telegram
   * sendRichMessageDraft) — a `<tg-thinking>` indicator labelled with the current
   * phase. `draftId` is a stable per-turn id (updates animate in place). The
   * preview is ephemeral (~30s) and is superseded by the turn's real answer.
   * Absent → no phase indicator (the ChatRenderer falls back to "typing…").
   */
  draft?(target: SendTarget, draftId: number, content: DraftContent): Promise<void>;
  /** "typing…" indicator; absent → no-op. */
  typing?(target: SendTarget, on: boolean): Promise<void>;
  stop(): Promise<void>;
}

/** The subset of a `ChannelAdapter` the ChatRenderer needs (gateway §5). */
export interface OutboundChannel {
  readonly maxChars: number;
  send(target: SendTarget, payload: OutboundPayload): Promise<MessageRef>;
  edit?(ref: MessageRef, payload: OutboundPayload): Promise<void>;
  draft?(target: SendTarget, draftId: number, content: DraftContent): Promise<void>;
  typing?(target: SendTarget, on: boolean): Promise<void>;
}
