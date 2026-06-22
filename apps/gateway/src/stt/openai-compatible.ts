/**
 * OpenAI-compatible STT (multimodal §7). A multipart `POST {baseURL}/audio/
 * transcriptions` with `model` + `file`, returning `{ text }` — the Whisper API
 * shape that StepFun (`model: step-asr`), OpenAI (`whisper-1`), and many others
 * speak. One class covers them all; presets live in ./index.ts. Raw `fetch` +
 * `FormData`, matching the Telegram adapter's transport style (no SDK dep).
 */
import type { SttInput, SttOptions, SttProvider } from './provider.js';

export interface OpenAiCompatibleSttOptions {
  /** Provider id for logs (e.g. 'stepfun'). */
  name?: string;
  /** API base incl. version, e.g. `https://api.stepfun.com/v1`. */
  baseURL: string;
  /** Transcription model, e.g. `step-asr` / `whisper-1`. */
  model: string;
  apiKey: string;
  /** `json` → parse `{text}`; `text` → use the raw body. Default `json`. */
  responseFormat?: 'json' | 'text';
  language?: string;
  /** Injectable fetch (tests). Default global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleStt implements SttProvider {
  readonly name: string;
  constructor(private readonly opts: OpenAiCompatibleSttOptions) {
    this.name = opts.name ?? 'openai-compatible';
  }

  async transcribe(input: SttInput, opts: SttOptions = {}): Promise<string> {
    const form = new FormData();
    form.set('model', this.opts.model);
    const fmt = this.opts.responseFormat ?? 'json';
    form.set('response_format', fmt);
    const lang = opts.language ?? this.opts.language;
    if (lang) form.set('language', lang);
    form.set(
      'file',
      new Blob([input.data], { type: input.mimeType ?? 'application/octet-stream' }),
      input.filename ?? 'audio.ogg',
    );

    const url = `${this.opts.baseURL.replace(/\/$/, '')}/audio/transcriptions`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`STT ${this.name} HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    if (fmt === 'text') return (await res.text()).trim();
    const json = (await res.json().catch(() => ({}))) as { text?: string };
    return (json.text ?? '').trim();
  }
}
