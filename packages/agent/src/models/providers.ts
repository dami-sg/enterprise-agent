/**
 * Built-in provider presets (agent §2.6) — a directory of well-known model
 * sources with their `kind` + base URL so a host can offer "add a provider" by
 * name instead of making the user look up endpoints. The actual model list is
 * still discovered dynamically from `${baseURL}/models` (see `ModelCatalog`);
 * presets only seed the access config (`ProviderConfig`), never secrets.
 *
 * Base URLs carry the version prefix so `${baseURL}/models` (discovery) and
 * `${baseURL}/chat/completions` (the OpenAI-compatible SDK) both resolve.
 */
import type { ProviderKind } from '@enterprise-agent/agent-contract';

export type ProviderRegion = 'cn' | 'global' | 'local';

export interface ProviderPreset {
  /** Default provider id (the `<id>` in `<id>:<model>` refs); user-overridable. */
  id: string;
  /** Human-readable name. */
  name: string;
  kind: ProviderKind;
  /** Omitted for official kinds (anthropic/openai/google use built-in endpoints). */
  baseURL?: string;
  /** Whether a key is needed for actual use (local servers: false). */
  requiresKey: boolean;
  region: ProviderRegion;
  /** Caveats from the endpoint reference (stability / completeness). */
  note?: string;
}

export const BUILTIN_PROVIDERS: ProviderPreset[] = [
  // -- 海外 (overseas) --
  { id: 'openai', name: 'OpenAI', kind: 'openai', requiresKey: true, region: 'global' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', requiresKey: true, region: 'global', note: '无 models 端点，模型列表内置' },
  { id: 'google', name: 'Google Gemini', kind: 'google', requiresKey: true, region: 'global' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', requiresKey: true, region: 'global', note: 'models 可不带 Key；对话需 Key' },
  // -- 国内 (China) --
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', requiresKey: true, region: 'cn' },
  { id: 'minimax', name: 'MiniMax', kind: 'openai-compatible', baseURL: 'https://api.minimaxi.com/v1', requiresKey: true, region: 'cn', note: '国内端点；国际为 api.minimax.io/v1。/models 可能返回不全' },
  { id: 'zhipu', name: '智谱 GLM', kind: 'openai-compatible', baseURL: 'https://open.bigmodel.cn/api/paas/v4', requiresKey: true, region: 'cn' },
  { id: 'dashscope', name: '阿里百炼 DashScope', kind: 'openai-compatible', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', requiresKey: true, region: 'cn' },
  { id: 'moonshot', name: '月之暗面 Kimi', kind: 'openai-compatible', baseURL: 'https://api.moonshot.cn/v1', requiresKey: true, region: 'cn' },

  // -- 本地推理 (local) --
  { id: 'ollama', name: 'Ollama', kind: 'openai-compatible', baseURL: 'http://localhost:11434/v1', requiresKey: false, region: 'local' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'openai-compatible', baseURL: 'http://localhost:1234/v1', requiresKey: false, region: 'local' },
  { id: 'vllm', name: 'vLLM', kind: 'openai-compatible', baseURL: 'http://localhost:8000/v1', requiresKey: false, region: 'local' },
];

/** Look up a preset by its id (case-insensitive). */
export function findProviderPreset(id: string): ProviderPreset | undefined {
  const lower = id.toLowerCase();
  return BUILTIN_PROVIDERS.find((p) => p.id.toLowerCase() === lower);
}
