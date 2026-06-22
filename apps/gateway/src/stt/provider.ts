/**
 * Speech-to-text provider abstraction (multimodal §7). Voice messages must be
 * transcribed before they reach the model (models don't take raw audio). This is
 * the seam: each backend (StepFun, OpenAI Whisper, …) implements `transcribe`;
 * the gateway selects one by config (see ./index.ts). Adding a backend = one new
 * class, no changes to callers.
 */

export interface SttInput {
  /** Raw audio bytes (e.g. a Telegram voice OGG/Opus, gateway §3.2). */
  data: Buffer;
  mimeType?: string;
  filename?: string;
}

export interface SttOptions {
  /** BCP-47-ish language hint (e.g. 'zh', 'en'); provider may ignore it. */
  language?: string;
}

export interface SttProvider {
  /** Stable id for logs/audit (e.g. 'stepfun'). */
  readonly name: string;
  /** Transcribe audio to text. Throws on transport/API failure (caller degrades). */
  transcribe(input: SttInput, opts?: SttOptions): Promise<string>;
}
