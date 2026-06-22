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
import type { MessageRef, OutboundChannel, SendTarget } from '../channels/adapter.js';
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

  constructor(
    private readonly channel: OutboundChannel,
    private readonly target: SendTarget,
    private readonly opts: RendererOptions = {},
  ) {
    this.canThink = typeof channel.draft === 'function';
    this.streaming = typeof channel.edit === 'function';
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
   * Push the current buffer to the platform. Streaming → edit-in-place (grow /
   * overflow into additional messages). Whole-message → only on `final`.
   */
  private flush(final: boolean): void {
    if (!this.streaming) {
      if (final) this.sendWhole(); // typing is kept warm by the tick (keepTyping)
      return;
    }
    // Split the *source* Markdown; each chunk is sent/formatted independently at
    // the adapter's transport boundary (Telegram posts it as a rich message, §5).
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
