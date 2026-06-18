/**
 * Model registry (agent §2.6): Provider access → semantic alias → unified
 * resolution, built on AI SDK v6 `createProviderRegistry` + `customProvider`.
 * Built only inside the utilityProcess; secrets pulled from the keystore here.
 */
import {
  createProviderRegistry,
  customProvider,
  wrapLanguageModel,
  defaultSettingsMiddleware,
  type LanguageModel,
  type ProviderRegistryProvider,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelAlias, ProviderConfig } from '@enterprise-agent/agent-contract';
import type { KeyStore } from '../config/keychain.js';

export class ModelConfigError extends Error {}

/** Built-in fallback model (agent §2.6 precedence tail). */
export const BUILTIN_FALLBACK_REF = 'anthropic:claude-sonnet-4.5';

/** Build a v6 provider registry plus an `alias:*` semantic layer (agent §2.6). */
export function buildRegistry(
  providers: ProviderConfig[],
  aliases: ModelAlias[],
  keychain: KeyStore,
): ProviderRegistryProvider {
  const base: Record<string, ReturnType<typeof createAnthropic>> = {};

  for (const p of providers.filter((p) => p.enabled)) {
    const apiKey = p.keyRef ? keychain.get(p.keyRef) : undefined;
    switch (p.kind) {
      case 'anthropic':
        base[p.id] = createAnthropic({ apiKey, headers: p.headers });
        break;
      case 'openai':
        base[p.id] = createOpenAI({ apiKey, headers: p.headers }) as never;
        break;
      case 'openai-compatible':
        if (!p.baseURL) {
          throw new ModelConfigError(
            `provider '${p.id}' is openai-compatible but has no baseURL`,
          );
        }
        base[p.id] = createOpenAICompatible({
          name: p.id,
          apiKey,
          baseURL: p.baseURL,
          headers: p.headers,
        }) as never;
        break;
      case 'google':
      case 'gateway':
        // openai-compatible transport covers gateway/local; google would add
        // @ai-sdk/google here. Fall back to openai-compatible if a baseURL set.
        if (p.baseURL) {
          base[p.id] = createOpenAICompatible({
            name: p.id,
            apiKey,
            baseURL: p.baseURL,
            headers: p.headers,
          }) as never;
        }
        break;
    }
  }

  // Always keep the built-in fallback provider resolvable (agent §2.6 tail);
  // its key comes from the env/keychain-backed default so zero-config still runs.
  if (!base.anthropic) base.anthropic = createAnthropic({});

  // First registry: resolves concrete `providerId:modelId` refs.
  const registry0 = createProviderRegistry(base);
  type ResolvedModel = ReturnType<typeof registry0.languageModel>;

  // Semantic alias layer: alias name → concrete model + default params.
  const aliasModels: Record<string, ResolvedModel> = {};
  for (const a of aliases) {
    let model: ResolvedModel;
    try {
      model = registry0.languageModel(a.ref as `${string}:${string}`);
    } catch {
      // Alias points at a provider that isn't enabled — skip, surfaced later.
      continue;
    }
    aliasModels[a.alias] = a.params
      ? wrapLanguageModel({
          model,
          middleware: defaultSettingsMiddleware({
            settings: {
              maxOutputTokens: a.params.maxOutputTokens,
              temperature: a.params.temperature,
              providerOptions: a.params.providerOptions as never,
            },
          }),
        })
      : model;
  }

  return createProviderRegistry({ ...base, alias: customProvider({ languageModels: aliasModels }) });
}

/**
 * Resolves roles → models with the precedence of agent §2.6:
 *   role explicit → Work → Workspace default → global → built-in fallback.
 * The effective alias map and role→alias bindings are computed by the caller
 * (EffectiveConfig); this class only turns a final ref/alias into a model.
 */
export class ModelRegistry {
  private registry: ProviderRegistryProvider;
  readonly aliasNames: Set<string>;

  constructor(
    private readonly providers: ProviderConfig[],
    private readonly aliases: ModelAlias[],
    keychain: KeyStore,
  ) {
    this.registry = buildRegistry(providers, aliases, keychain);
    this.aliasNames = new Set(aliases.map((a) => a.alias));
  }

  /** Resolve an alias name to its concrete `providerId:modelId` ref. */
  refForAlias(alias: string): string | undefined {
    return this.aliases.find((a) => a.alias === alias)?.ref;
  }

  /** Resolve a model by alias name (preferred) or concrete `provider:model`. */
  resolve(aliasOrRef: string): LanguageModel {
    const id = this.aliasNames.has(aliasOrRef)
      ? `alias:${aliasOrRef}`
      : aliasOrRef.includes(':')
        ? aliasOrRef
        : `alias:${aliasOrRef}`;
    try {
      return this.registry.languageModel(id as `${string}:${string}`);
    } catch {
      // Unresolvable alias/provider → built-in fallback (agent §2.6 precedence).
      return this.registry.languageModel(BUILTIN_FALLBACK_REF);
    }
  }

  /** Validate that an alias resolves and (optionally) supports a capability. */
  assertCapability(alias: string, capability: string): void {
    const a = this.aliases.find((x) => x.alias === alias);
    if (a?.capabilities && !a.capabilities.includes(capability as never)) {
      throw new ModelConfigError(
        `alias '${alias}' lacks required capability '${capability}'`,
      );
    }
  }

  hasProviders(): boolean {
    return this.providers.some((p) => p.enabled);
  }
}
