/**
 * ChatRenderer (gateway §5) — the chat-platform analogue of the headless
 * `LineRenderer`. It projects one turn's `AgentStreamEvent` text onto platform
 * messages:
 *   - edit-capable platforms (Telegram): throttle `text-delta` (~1s) and edit the
 *     same message in place.
 *   - whole-message platforms (WeChat / WhatsApp): hold text until `run-finish`,
 *     then send it split into ≤maxChars chunks, keeping "typing…" alive meanwhile.
 * Sends are serialized on an internal promise chain so streamed edits never race
 * out of order. One renderer per active turn on a conversation.
 *
 * While the agent works, a platform with rich drafts (Telegram) shows an
 * ephemeral `<tg-thinking>` indicator via `draft`, labelled with the current
 * phase (`setStatus`: Thinking… / Tool calling / Sub Agent running), so the user
 * isn't left staring at silence; the answer itself streams the normal way.
 */
import type { Attachment, MessageRef, OutboundChannel, OutboundPayload, SendTarget } from '../channels/adapter.js';
import { splitForLimit } from './split.js';

/** Minimum gap between status drafts — coalesces rapid phase flips (rate safety),
 *  but short enough that a brief Tool calling / Sub Agent phase still gets shown. */
const DRAFT_MIN_MS = 1_000;
/** Re-push the *same* status before its ~30s server-side expiry, so a long phase
 *  (e.g. a sub-agent running > 30s) keeps showing instead of silently lapsing. */
const DRAFT_KEEPALIVE_MS = 20_000;
/** Re-send "typing…" at least this often so the running indicator never lapses
 *  (Telegram's chat action expires after ~5s). */
const TYPING_REFRESH_MS = 4_000;

let draftSeq = 0;
/** A non-zero per-turn draft id; updates sharing an id animate (Telegram §5). */
function nextDraftId(): number {
  draftSeq = (draftSeq % 0x7fffffff) + 1;
  return draftSeq;
}

export interface RendererOptions {
  /** Edit throttle / typing-refresh interval (ms). Default 1000. */
  throttleMs?: number;
  /** Emit lightweight tool/sub-agent status lines into chat (gateway §5). Default false. */
  verbose?: boolean;
  /**
   * Max chars to keep INLINE in chat (gateway §5, "做厚聊天"). A final answer over
   * this is delivered as a `.md` document instead of a wall of split bubbles —
   * with a short streamed preview on edit-capable channels. Default `maxChars`
   * (anything that wouldn't fit one message becomes a file).
   */
  inlineLimit?: number;
  /** Surface a send failure (logging hook); never throws into the event loop. */
  onError?: (err: unknown) => void;
}

export class ConversationRenderer {
  private buffer = '';
  /** Messages already materialized for this turn (streamed chunks). */
  private readonly sent: MessageRef[] = [];
  private readonly lastChunks: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private done = false;
  private readonly streaming: boolean;
  /** Telegram `<tg-thinking>` indicator (a rich draft), labelled by phase. */
  private readonly canThink: boolean;
  private readonly draftId = nextDraftId();
  /** Current phase label to show (e.g. "Thinking…"); '' = nothing to show yet. */
  private status = '';
  /** The label last pushed as a draft, and when — for change-detect + keep-alive. */
  private lastDraftLabel = '';
  private lastDraftAt = 0;
  /** Epoch-ms of the last "typing…" action, to keep it alive the whole turn. */
  private lastTypingAt = 0;
  /** Over this many chars, the final answer goes out as a `.md` file (gateway §5). */
  private readonly inlineLimit: number;
  /** Set once the overflow file has been delivered, so it's sent at most once. */
  private fileSent = false;

  constructor(
    private readonly channel: OutboundChannel,
    private readonly target: SendTarget,
    private readonly opts: RendererOptions = {},
  ) {
    this.canThink = typeof channel.draft === 'function';
    this.streaming = typeof channel.edit === 'function';
    this.inlineLimit = opts.inlineLimit ?? channel.maxChars;
  }

  /**
   * Begin the turn: show "typing…" immediately and keep it alive on the tick for
   * the whole run — so even a long tool / sub-agent phase (no reasoning, no answer
   * yet) still reads as "running" rather than a dead chat (gateway §5).
   */
  start(): void {
    this.keepTyping();
    this.schedule();
  }

  /** Root-orchestrator text only (gateway §5; sub-agent chatter is not the answer). */
  appendText(text: string): void {
    if (this.done) return;
    this.buffer += text;
    this.schedule();
  }

  /**
   * Set the current activity phase (gateway §5) — Thinking… / Tool calling / Sub
   * Agent running — shown as a `<tg-thinking>` draft (Telegram) so the user sees
   * what the agent is doing instead of a silent gap. Pushes promptly on a change
   * (rate-limited) and is kept alive across the ~30s expiry by the tick. Shown for
   * the whole turn — tool / sub-agent phases often occur *after* a preamble line,
   * so it must NOT stop at the first answer token. The answer streams as its own
   * message; the draft is ephemeral and ends when the turn finishes.
   */
  setStatus(label: string): void {
    if (this.done || !this.canThink) return;
    this.status = label;
    this.pumpDraft(); // reflect a phase change without waiting for the next tick
  }

  /** Optional status line (verbose mode), sent as its own message. */
  noteStatus(line: string): void {
    if (!this.opts.verbose) return;
    this.note(line);
  }

  /** Out-of-band notice (e.g. a registered deliverable), sent as its own message
   *  on the serialized send chain so it never races a streamed edit. */
  note(line: string): void {
    if (this.done) return;
    this.enqueue(async () => {
      await this.channel.send(this.target, { kind: 'text', text: line });
    });
  }

  /** Finalize: flush the remaining text and drop the typing indicator. */
  async finish(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.clearTimer();
    this.flush(true);
    this.setTyping(false);
    await this.queue;
  }

  /** Turn ended in error: surface the message and stop typing. */
  async fail(message: string): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.clearTimer();
    // Send whatever partial text we have, then the error.
    if (this.buffer.trim()) this.flush(true);
    this.enqueue(async () => {
      await this.channel.send(this.target, { kind: 'text', text: `⚠ 运行出错：${message}` });
    });
    this.setTyping(false);
    await this.queue;
  }

  // -- internals --

  private schedule(): void {
    if (this.timer || this.done) return;
    const ms = this.opts.throttleMs ?? 1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.done) {
        this.keepTyping(); // keep the running indicator alive
        this.pumpDraft(); // catch up a throttled change + keep the phase alive
      }
      this.flush(false);
      if (!this.done) this.schedule();
    }, ms);
    // Don't keep the event loop alive solely for a throttle tick.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Push the current buffer to the platform (gateway §5). Streaming → keep ONE
   * live message edited in place with the first-message preview; whole-message →
   * send only on `final`. A final answer that overflows one message is delivered
   * as a `.md` file (see `deliverLong`) rather than a wall of split bubbles.
   */
  private flush(final: boolean): void {
    const trimmed = this.buffer.trimEnd();
    if (!trimmed) return;

    if (this.streaming) {
      // Live preview: maintain message 0 with the first chunk (never spill into
      // more bubbles); the full answer arrives as a file at finish if it's long.
      const preview = splitForLimit(trimmed, this.channel.maxChars)[0] ?? trimmed;
      if (this.lastChunks[0] !== preview) {
        this.lastChunks[0] = preview;
        this.enqueue(async () => {
          if (this.sent[0] && this.channel.edit) await this.channel.edit(this.sent[0], { kind: 'text', text: preview });
          else this.sent[0] = await this.channel.send(this.target, { kind: 'text', text: preview });
        });
      }
      if (final) this.deliverLong(trimmed);
      return;
    }

    // Whole-message platforms: nothing until final; then inline-or-file.
    if (!final) return;
    if (this.isLong(trimmed)) {
      this.deliverLong(trimmed);
      return;
    }
    const chunks = splitForLimit(trimmed, this.channel.maxChars);
    this.enqueue(async () => {
      for (const chunk of chunks) await this.channel.send(this.target, { kind: 'text', text: chunk });
    });
  }

  private isLong(text: string): boolean {
    return text.length > this.inlineLimit;
  }

  /** Deliver an over-length answer as a `.md` document (once), with a caption. */
  private deliverLong(text: string): void {
    if (this.fileSent || !this.isLong(text)) return;
    this.fileSent = true;
    this.enqueue(async () => {
      await this.channel.send(this.target, this.filePayload(text));
    });
  }

  private filePayload(text: string): OutboundPayload {
    const media: Attachment = {
      kind: 'file',
      data: Buffer.from(text, 'utf8'),
      filename: 'answer.md',
      mimeType: 'text/markdown',
    };
    return { kind: 'media', media, caption: '📄 回答较长，完整内容见文件。' };
  }

  /**
   * Push the current phase as a `<tg-thinking>` draft when due: a changed label
   * is rate-limited to DRAFT_MIN_MS (coalescing rapid phase flips); an unchanged
   * one is re-pushed every DRAFT_KEEPALIVE_MS so a long phase survives the ~30s
   * expiry. Drafts are best-effort and self-skip during a 429 cooldown.
   */
  private pumpDraft(): void {
    if (this.done || !this.canThink || !this.status) return;
    const now = Date.now();
    const since = now - this.lastDraftAt;
    const changed = this.status !== this.lastDraftLabel;
    if (changed ? since < DRAFT_MIN_MS : since < DRAFT_KEEPALIVE_MS) return;
    this.lastDraftLabel = this.status;
    this.lastDraftAt = now;
    const label = this.status;
    this.enqueue(() => this.channel.draft!(this.target, this.draftId, { status: label }));
  }

  /** Refresh "typing…" at most every TYPING_REFRESH_MS so it never lapses mid-run. */
  private keepTyping(): void {
    const now = Date.now();
    if (this.lastTypingAt && now - this.lastTypingAt < TYPING_REFRESH_MS) return;
    this.lastTypingAt = now;
    this.setTyping(true);
  }

  private setTyping(on: boolean): void {
    if (!this.channel.typing) return;
    const fn = this.channel.typing.bind(this.channel);
    this.enqueue(async () => {
      await fn(this.target, on);
    });
  }

  /** Serialize an async side-effect on the send chain; swallow errors to a hook. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => this.opts.onError?.(err));
  }
}
