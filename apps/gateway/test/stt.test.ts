/**
 * STT provider + factory (multimodal §7). The OpenAI-compatible client (StepFun /
 * Whisper shape) and the config→provider factory, driven by an injected fetch.
 */
import { describe, it, expect } from 'vitest';
import type { KeyStore } from '@enterprise-agent/agent';
import { OpenAiCompatibleStt } from '../src/stt/openai-compatible.js';
import { createSttProvider } from '../src/stt/index.js';

function keychain(entries: Record<string, string>): KeyStore {
  const m = new Map(Object.entries(entries));
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) } as KeyStore;
}

describe('OpenAiCompatibleStt', () => {
  it('posts multipart to /audio/transcriptions and returns the json text (StepFun shape)', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const stt = new OpenAiCompatibleStt({
      name: 'stepfun',
      baseURL: 'https://api.stepfun.com/v1',
      model: 'step-asr',
      apiKey: 'K',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return new Response(JSON.stringify({ text: '你好世界' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const out = await stt.transcribe({ data: Buffer.from('OGG'), mimeType: 'audio/ogg', filename: 'voice.ogg' }, { language: 'zh' });
    expect(out).toBe('你好世界');
    expect(captured!.url).toBe('https://api.stepfun.com/v1/audio/transcriptions');
    expect(captured!.init.method).toBe('POST');
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer K');
    const form = captured!.init.body as FormData;
    expect(form.get('model')).toBe('step-asr');
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBe('zh');
    expect((form.get('file') as File).name).toBe('voice.ogg');
  });

  it('uses the raw body when response_format is text', async () => {
    const stt = new OpenAiCompatibleStt({
      baseURL: 'https://x/v1',
      model: 'm',
      apiKey: 'K',
      responseFormat: 'text',
      fetchImpl: (async () => new Response('  plain transcript  ', { status: 200 })) as typeof fetch,
    });
    expect(await stt.transcribe({ data: Buffer.from('a') })).toBe('plain transcript');
  });

  it('throws with the status on a non-2xx', async () => {
    const stt = new OpenAiCompatibleStt({
      baseURL: 'https://x/v1',
      model: 'm',
      apiKey: 'K',
      fetchImpl: (async () => new Response('bad key', { status: 401 })) as typeof fetch,
    });
    await expect(stt.transcribe({ data: Buffer.from('a') })).rejects.toThrow(/401/);
  });
});

describe('createSttProvider', () => {
  it('returns undefined when STT is unconfigured', () => {
    expect(createSttProvider(undefined, keychain({}))).toBeUndefined();
    expect(createSttProvider({}, keychain({}))).toBeUndefined();
  });

  it('builds the stepfun and openai preset providers', () => {
    expect(createSttProvider({ provider: 'stepfun', apiKey: { keyRef: 'k' } }, keychain({ k: 'K' }))?.name).toBe('stepfun');
    expect(createSttProvider({ provider: 'openai', apiKey: { keyRef: 'k' } }, keychain({ k: 'K' }))?.name).toBe('openai');
  });

  it('accepts any openai-compatible endpoint via explicit baseURL+model', () => {
    const p = createSttProvider(
      { provider: 'custom', baseURL: 'https://api.example.com/v1', model: 'asr-1', apiKey: { keyRef: 'k' } },
      keychain({ k: 'K' }),
    );
    expect(p?.name).toBe('custom');
  });

  it('rejects an unknown provider with no baseURL/model, and a missing key', () => {
    expect(() => createSttProvider({ provider: 'mystery', apiKey: { keyRef: 'k' } }, keychain({ k: 'K' }))).toThrow(/baseURL/);
    expect(() => createSttProvider({ provider: 'stepfun' }, keychain({}))).toThrow(/key/);
  });
});
