/**
 * STT provider factory (multimodal §7). Builds the configured `SttProvider` from
 * `gateway.json`'s `stt` block + the keychain. Presets fill in the well-known
 * endpoints; any OpenAI-compatible `/audio/transcriptions` service works by
 * setting `baseURL`+`model` explicitly. Adding a non-compatible backend (e.g. a
 * future MiniMax ASR) = a new provider class wired into the switch here.
 */
import type { KeyStore } from '@enterprise-agent/agent';
import type { SttConfig } from '../config/gateway-config.js';
import type { SttProvider } from './provider.js';
import { OpenAiCompatibleStt } from './openai-compatible.js';

export type { SttProvider, SttInput, SttOptions } from './provider.js';
export { OpenAiCompatibleStt } from './openai-compatible.js';

/**
 * Built-in presets. Both speak the OpenAI-compatible `/audio/transcriptions`
 * shape, so the one client covers them; any other compatible endpoint works by
 * setting `baseURL`+`model` explicitly. (MiniMax is intentionally absent — it
 * has no public ASR API, only TTS.)
 */
const PRESETS: Record<string, { baseURL: string; model: string }> = {
  openai: { baseURL: 'https://api.openai.com/v1', model: 'whisper-1' },
  stepfun: { baseURL: 'https://api.stepfun.com/v1', model: 'step-asr' },
};

/**
 * Build the STT provider, or `undefined` when STT isn't configured (voice then
 * just gets saved, multimodal §8). Throws on a misconfigured block so a typo
 * fails loud at startup rather than silently dropping every voice message.
 */
export function createSttProvider(cfg: SttConfig | undefined, keychain: KeyStore): SttProvider | undefined {
  if (!cfg || !cfg.provider) return undefined;
  const preset = PRESETS[cfg.provider];
  const baseURL = cfg.baseURL ?? preset?.baseURL;
  const model = cfg.model ?? preset?.model;
  if (!baseURL || !model) {
    throw new Error(
      `stt: provider '${cfg.provider}' 未知，需显式提供 baseURL + model（或用预设 stepfun / openai）。`,
    );
  }
  const apiKey = cfg.apiKey ? keychain.get(cfg.apiKey.keyRef) : undefined;
  if (!apiKey) {
    throw new Error(`stt: 缺少 API key（配置 stt.apiKey.keyRef='${cfg.apiKey?.keyRef ?? '?'}' 并写入 keychain）。`);
  }
  return new OpenAiCompatibleStt({
    name: cfg.provider,
    baseURL,
    model,
    apiKey,
    responseFormat: cfg.responseFormat,
    language: cfg.language,
  });
}
