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
 */
import type { MessageRef, OutboundChannel, SendTarget } from '../channels/adapter.js';
import { splitForLimit } from './split.js';

export interface RendererOptions {
  /** Edit throttle / typing-refresh interval (ms). Default 1000. */
  throttleMs?: number;
  /** Emit lightweight tool/sub-agent status lines into chat (gateway §5). Default false. */
  verbose?: boolean;
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

  constructor(
    private readonly channel: OutboundChannel,
    private readonly target: SendTarget,
    private readonly opts: RendererOptions = {},
  ) {
    this.streaming = typeof channel.edit === 'function';
  }

  /** Begin the turn: show "typing…" and (whole-message mode) keep refreshing it. */
  start(): void {
    this.setTyping(true);
    if (!this.streaming) this.schedule(); // refresh typing on the interval
  }

  /** Root-orchestrator text only (gateway §5; sub-agent chatter is not the answer). */
  appendText(text: string): void {
    if (this.done) return;
    this.buffer += text;
    this.schedule();
  }

  /** Optional status line (verbose mode), sent as its own message. */
  noteStatus(line: string): void {
    if (!this.opts.verbose || this.done) return;
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
   * Push the current buffer to the platform. Streaming → edit-in-place (grow /
   * overflow into additional messages). Whole-message → only on `final`.
   */
  private flush(final: boolean): void {
    if (!this.streaming) {
      if (final) this.sendWhole();
      else this.setTyping(true); // keep "typing…" warm between ticks
      return;
    }
    // Split the *source* Markdown; the adapter applies its `format` per chunk at
    // the send/edit boundary, so tag-based formats never get cut mid-tag (§5).
    const trimmed = this.buffer.trimEnd();
    if (!trimmed) return;
    const chunks = splitForLimit(trimmed, this.channel.maxChars);
    this.enqueue(async () => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        if (this.lastChunks[i] === chunk) continue;
        this.lastChunks[i] = chunk;
        const existing = this.sent[i];
        if (existing && this.channel.edit) {
          await this.channel.edit(existing, { kind: 'text', text: chunk });
        } else {
          this.sent[i] = await this.channel.send(this.target, { kind: 'text', text: chunk });
        }
      }
    });
  }

  private sendWhole(): void {
    const trimmed = this.buffer.trim();
    if (!trimmed) return;
    const chunks = splitForLimit(trimmed, this.channel.maxChars);
    this.enqueue(async () => {
      for (const chunk of chunks) {
        await this.channel.send(this.target, { kind: 'text', text: chunk });
      }
    });
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
