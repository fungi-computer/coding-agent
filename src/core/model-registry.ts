/**
 * Model registry - manages built-in and custom models, provides API key resolution.
 */

import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  registerApiProvider,
  resetApiProviders,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

import type { AuthStorage } from "./auth-storage.js";

import { getAgentDir } from "../config.js";
import {
  clearConfigValueCache,
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeadersOrThrow,
} from "./resolve-config-value.js";
// Schema for OpenRouter routing preferences
const PercentileCutoffsSchema = Type.Object({
  p50: Type.Optional(Type.Number()),
  p75: Type.Optional(Type.Number()),
  p90: Type.Optional(Type.Number()),
  p99: Type.Optional(Type.Number()),
});

const OpenRouterRoutingSchema = Type.Object({
  allow_fallbacks: Type.Optional(Type.Boolean()),
  data_collection: Type.Optional(
    Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
  ),
  enforce_distillable_text: Type.Optional(Type.Boolean()),
  ignore: Type.Optional(Type.Array(Type.String())),
  max_price: Type.Optional(
    Type.Object({
      audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
    }),
  ),
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
  preferred_max_latency: Type.Optional(
    Type.Union([Type.Number(), PercentileCutoffsSchema]),
  ),
  preferred_min_throughput: Type.Optional(
    Type.Union([Type.Number(), PercentileCutoffsSchema]),
  ),
  quantizations: Type.Optional(Type.Array(Type.String())),
  require_parameters: Type.Optional(Type.Boolean()),
  sort: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Object({
        by: Type.Optional(Type.String()),
        partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      }),
    ]),
  ),
  zdr: Type.Optional(Type.Boolean()),
});

// Schema for Vercel AI Gateway routing preferences
const VercelGatewayRoutingSchema = Type.Object({
  only: Type.Optional(Type.Array(Type.String())),
  order: Type.Optional(Type.Array(Type.String())),
});

// Schema for OpenAI compatibility settings
const ReasoningEffortMapSchema = Type.Object({
  high: Type.Optional(Type.String()),
  low: Type.Optional(Type.String()),
  medium: Type.Optional(Type.String()),
  minimal: Type.Optional(Type.String()),
  xhigh: Type.Optional(Type.String()),
});

const OpenAICompletionsCompatSchema = Type.Object({
  maxTokensField: Type.Optional(
    Type.Union([
      Type.Literal("max_completion_tokens"),
      Type.Literal("max_tokens"),
    ]),
  ),
  openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
  reasoningEffortMap: Type.Optional(ReasoningEffortMapSchema),
  requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
  requiresThinkingAsText: Type.Optional(Type.Boolean()),
  requiresToolResultName: Type.Optional(Type.Boolean()),
  supportsDeveloperRole: Type.Optional(Type.Boolean()),
  supportsReasoningEffort: Type.Optional(Type.Boolean()),
  supportsStore: Type.Optional(Type.Boolean()),
  supportsStrictMode: Type.Optional(Type.Boolean()),
  supportsUsageInStreaming: Type.Optional(Type.Boolean()),
  thinkingFormat: Type.Optional(
    Type.Union([
      Type.Literal("openai"),
      Type.Literal("openrouter"),
      Type.Literal("zai"),
      Type.Literal("qwen"),
      Type.Literal("qwen-chat-template"),
    ]),
  ),
  vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
});

const OpenAIResponsesCompatSchema = Type.Object({
  // Reserved for future use
});

const OpenAICompatSchema = Type.Union([
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
]);

// Schema for custom model definition
// Most fields are optional with sensible defaults for local models (Ollama, LM Studio, etc.)
const ModelDefinitionSchema = Type.Object({
  api: Type.Optional(Type.String({ minLength: 1 })),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  compat: Type.Optional(OpenAICompatSchema),
  contextWindow: Type.Optional(Type.Number()),
  cost: Type.Optional(
    Type.Object({
      cacheRead: Type.Number(),
      cacheWrite: Type.Number(),
      input: Type.Number(),
      output: Type.Number(),
    }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  id: Type.String({ minLength: 1 }),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  ),
  maxTokens: Type.Optional(Type.Number()),
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
});

// Schema for per-model overrides (all fields optional, merged with built-in model)
const ModelOverrideSchema = Type.Object({
  compat: Type.Optional(OpenAICompatSchema),
  contextWindow: Type.Optional(Type.Number()),
  cost: Type.Optional(
    Type.Object({
      cacheRead: Type.Optional(Type.Number()),
      cacheWrite: Type.Optional(Type.Number()),
      input: Type.Optional(Type.Number()),
      output: Type.Optional(Type.Number()),
    }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  input: Type.Optional(
    Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  ),
  maxTokens: Type.Optional(Type.Number()),
  name: Type.Optional(Type.String({ minLength: 1 })),
  reasoning: Type.Optional(Type.Boolean()),
});

type ModelOverride = Static<typeof ModelOverrideSchema>;

const ProviderConfigSchema = Type.Object({
  api: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String({ minLength: 1 })),
  authHeader: Type.Optional(Type.Boolean()),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  compat: Type.Optional(OpenAICompatSchema),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  modelOverrides: Type.Optional(
    Type.Record(Type.String(), ModelOverrideSchema),
  ),
  models: Type.Optional(Type.Array(ModelDefinitionSchema)),
});

const ModelsConfigSchema = Type.Object({
  providers: Type.Record(Type.String(), ProviderConfigSchema),
});

// Compile the schema once for runtime validation. Replaces the previous
// ajv-based validator, which doesn't work in Cloudflare Workers'
// eval-restricted runtime. typebox/compile produces a Validator that
// runs in any JS environment.
const validateModelsConfig = Compile(ModelsConfigSchema);

export type ResolvedRequestAuth =
  | {
      apiKey?: string;
      headers?: Record<string, string>;
      ok: true;
    }
  | {
      error: string;
      ok: false;
    };

/** Result of loading custom models from models.json */
interface CustomModelsResult {
  error: string | undefined;
  /** Per-model overrides: provider -> modelId -> override */
  modelOverrides: Map<string, Map<string, ModelOverride>>;
  models: Model<Api>[];
  /** Providers with baseUrl/headers/apiKey overrides for built-in models */
  overrides: Map<string, ProviderOverride>;
}

type ModelsConfig = Static<typeof ModelsConfigSchema>;

/** Provider override config (baseUrl, compat) without request auth/headers */
interface ProviderOverride {
  baseUrl?: string;
  compat?: Model<Api>["compat"];
}

interface ProviderRequestConfig {
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
}

/**
 * Deep merge a model override into a model.
 * Handles nested objects (cost, compat) by merging rather than replacing.
 */
function applyModelOverride(
  model: Model<Api>,
  override: ModelOverride,
): Model<Api> {
  const result = { ...model };

  // Simple field overrides
  if (override.name !== undefined) result.name = override.name;
  if (override.reasoning !== undefined) result.reasoning = override.reasoning;
  if (override.input !== undefined)
    result.input = override.input as ("image" | "text")[];
  if (override.contextWindow !== undefined)
    result.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;

  // Merge cost (partial override)
  if (override.cost) {
    result.cost = {
      cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
      cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
      input: override.cost.input ?? model.cost.input,
      output: override.cost.output ?? model.cost.output,
    };
  }

  // Deep merge compat
  result.compat = mergeCompat(model.compat, override.compat);

  return result;
}

function emptyCustomModelsResult(error?: string): CustomModelsResult {
  return { error, modelOverrides: new Map(), models: [], overrides: new Map() };
}

function mergeCompat(
  baseCompat: Model<Api>["compat"],
  overrideCompat: ModelOverride["compat"],
): Model<Api>["compat"] | undefined {
  if (!overrideCompat) return baseCompat;

  const base = baseCompat as
    | OpenAICompletionsCompat
    | OpenAIResponsesCompat
    | undefined;
  const override = overrideCompat as
    | OpenAICompletionsCompat
    | OpenAIResponsesCompat;
  const merged = { ...base, ...override } as
    | OpenAICompletionsCompat
    | OpenAIResponsesCompat;

  const baseCompletions = base as OpenAICompletionsCompat | undefined;
  const overrideCompletions = override as OpenAICompletionsCompat;
  const mergedCompletions = merged as OpenAICompletionsCompat;

  if (
    baseCompletions?.openRouterRouting ||
    overrideCompletions.openRouterRouting
  ) {
    mergedCompletions.openRouterRouting = {
      ...baseCompletions?.openRouterRouting,
      ...overrideCompletions.openRouterRouting,
    };
  }

  if (
    baseCompletions?.vercelGatewayRouting ||
    overrideCompletions.vercelGatewayRouting
  ) {
    mergedCompletions.vercelGatewayRouting = {
      ...baseCompletions?.vercelGatewayRouting,
      ...overrideCompletions.vercelGatewayRouting,
    };
  }

  return merged as Model<Api>["compat"];
}

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * Input type for registerProvider API.
 */
export interface ProviderConfigInput {
  api?: Api;
  apiKey?: string;
  authHeader?: boolean;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: {
    api?: Api;
    baseUrl?: string;
    compat?: Model<Api>["compat"];
    contextWindow: number;
    cost: {
      cacheRead: number;
      cacheWrite: number;
      input: number;
      output: number;
    };
    headers?: Record<string, string>;
    id: string;
    input: ("image" | "text")[];
    maxTokens: number;
    name: string;
    reasoning: boolean;
  }[];
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}

/**
 * Model registry - loads and manages models, resolves API keys via AuthStorage.
 */
export class ModelRegistry {
  private loadError: string | undefined = undefined;
  private modelRequestHeaders = new Map<string, Record<string, string>>();
  private models: Model<Api>[] = [];
  private providerRequestConfigs = new Map<string, ProviderRequestConfig>();
  private registeredProviders = new Map<string, ProviderConfigInput>();

  private constructor(
    readonly authStorage: AuthStorage,
    private modelsJsonPath: string | undefined,
  ) {
    this.loadModels();
  }

  static create(
    authStorage: AuthStorage,
    modelsJsonPath: string = join(getAgentDir(), "models.json"),
  ): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath);
  }

  static inMemory(authStorage: AuthStorage): ModelRegistry {
    return new ModelRegistry(authStorage, undefined);
  }

  /**
   * Find a model by provider and ID.
   */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  }

  /**
   * Get all models (built-in + custom).
   * If models.json had errors, returns only built-in models.
   */
  getAll(): Model<Api>[] {
    return this.models;
  }

  /**
   * Get API key and request headers for a model.
   */
  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    try {
      const providerConfig = this.providerRequestConfigs.get(model.provider);
      const apiKeyFromAuthStorage = await this.authStorage.getApiKey(
        model.provider,
        { includeFallback: false },
      );
      const apiKey =
        apiKeyFromAuthStorage ??
        (providerConfig?.apiKey
          ? resolveConfigValueOrThrow(
              providerConfig.apiKey,
              `API key for provider "${model.provider}"`,
            )
          : undefined);

      const providerHeaders = resolveHeadersOrThrow(
        providerConfig?.headers,
        `provider "${model.provider}"`,
      );
      const modelHeaders = resolveHeadersOrThrow(
        this.modelRequestHeaders.get(
          this.getModelRequestKey(model.provider, model.id),
        ),
        `model "${model.provider}/${model.id}"`,
      );

      let headers =
        model.headers || providerHeaders || modelHeaders
          ? { ...model.headers, ...providerHeaders, ...modelHeaders }
          : undefined;

      if (providerConfig?.authHeader) {
        if (!apiKey) {
          return {
            error: `No API key found for "${model.provider}"`,
            ok: false,
          };
        }
        headers = { ...headers, Authorization: `Bearer ${apiKey}` };
      }

      return {
        apiKey,
        headers:
          headers && Object.keys(headers).length > 0 ? headers : undefined,
        ok: true,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  }

  /**
   * Get API key for a provider.
   */
  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const apiKey = await this.authStorage.getApiKey(provider, {
      includeFallback: false,
    });
    if (apiKey !== undefined) {
      return apiKey;
    }

    const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
    return providerApiKey
      ? resolveConfigValueUncached(providerApiKey)
      : undefined;
  }

  /**
   * Get only models that have auth configured.
   * This is a fast check that doesn't refresh OAuth tokens.
   */
  getAvailable(): Model<Api>[] {
    return this.models.filter((m) => this.hasConfiguredAuth(m));
  }

  /**
   * Get any error from loading models.json (undefined if no error).
   */
  getError(): string | undefined {
    return this.loadError;
  }

  /**
   * Get API key for a model.
   */
  hasConfiguredAuth(model: Model<Api>): boolean {
    return (
      this.authStorage.hasAuth(model.provider) ||
      this.providerRequestConfigs.get(model.provider)?.apiKey !== undefined
    );
  }

  /**
   * Check if a model is using OAuth credentials (subscription).
   */
  isUsingOAuth(model: Model<Api>): boolean {
    const cred = this.authStorage.get(model.provider);
    return cred?.type === "oauth";
  }

  /**
   * Reload models from disk (built-in + custom from models.json).
   */
  refresh(): void {
    this.providerRequestConfigs.clear();
    this.modelRequestHeaders.clear();
    this.loadError = undefined;

    // Ensure dynamic API/OAuth registrations are rebuilt from current provider state.
    resetApiProviders();

    this.loadModels();

    for (const [providerName, config] of this.registeredProviders.entries()) {
      this.applyProviderConfig(providerName, config);
    }
  }

  /**
   * Register a provider dynamically (from extensions).
   *
   * If provider has models: replaces all existing models for this provider.
   * If provider has only baseUrl/headers: overrides existing models' URLs.
   * If provider has oauth: registers OAuth provider for /login support.
   */
  registerProvider(providerName: string, config: ProviderConfigInput): void {
    this.validateProviderConfig(providerName, config);
    this.applyProviderConfig(providerName, config);
    this.registeredProviders.set(providerName, config);
  }

  /**
   * Unregister a previously registered provider.
   *
   * Removes the provider from the registry and reloads models from disk so that
   * built-in models overridden by this provider are restored to their original state.
   * Also resets dynamic OAuth and API stream registrations before reapplying
   * remaining dynamic providers.
   * Has no effect if the provider was never registered.
   */
  unregisterProvider(providerName: string): void {
    if (!this.registeredProviders.has(providerName)) return;
    this.registeredProviders.delete(providerName);
    this.refresh();
  }

  private applyProviderConfig(
    providerName: string,
    config: ProviderConfigInput,
  ): void {
    // OAuth provider configuration is no longer supported in pi-ai 0.83.0.

    if (config.streamSimple) {
      const streamSimple = config.streamSimple;
      registerApiProvider(
        {
          api: config.api!,
          stream: (model, context, options) =>
            streamSimple(model, context, options as SimpleStreamOptions),
          streamSimple,
        },
        `provider:${providerName}`,
      );
    }

    this.storeProviderRequestConfig(providerName, config);

    if (config.models && config.models.length > 0) {
      // Full replacement: remove existing models for this provider
      this.models = this.models.filter((m) => m.provider !== providerName);

      // Parse and add new models
      for (const modelDef of config.models) {
        const api = modelDef.api || config.api;
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        this.models.push({
          api: api as Api,
          baseUrl: config.baseUrl!,
          compat: modelDef.compat,
          contextWindow: modelDef.contextWindow,
          cost: modelDef.cost,
          headers: undefined,
          id: modelDef.id,
          input: modelDef.input as ("image" | "text")[],
          maxTokens: modelDef.maxTokens,
          name: modelDef.name,
          provider: providerName,
          reasoning: modelDef.reasoning,
        } as Model<Api>);
      }
    } else if (config.baseUrl || config.headers) {
      // Override-only: update baseUrl for existing models. Request headers are resolved per request.
      this.models = this.models.map((m) => {
        if (m.provider !== providerName) return m;
        return {
          ...m,
          baseUrl: config.baseUrl ?? m.baseUrl,
        };
      });
    }
  }

  private getModelRequestKey(provider: string, modelId: string): string {
    return `${provider}:${modelId}`;
  }

  /** Load built-in models and apply provider/model overrides */
  private loadBuiltInModels(
    overrides: Map<string, ProviderOverride>,
    modelOverrides: Map<string, Map<string, ModelOverride>>,
  ): Model<Api>[] {
    return getProviders()
      .filter((provider) => !provider.startsWith("cloudflare"))
      .flatMap((provider) => {
        const models = getModels(provider as any) as Model<Api>[];
        const providerOverride = overrides.get(provider);
        const perModelOverrides = modelOverrides.get(provider);

        return models.map((m) => {
          let model = m;

          // Apply provider-level baseUrl/headers/compat override
          if (providerOverride) {
            model = {
              ...model,
              baseUrl: providerOverride.baseUrl ?? model.baseUrl,
              compat: mergeCompat(model.compat, providerOverride.compat),
            };
          }

          // Apply per-model override
          const modelOverride = perModelOverrides?.get(m.id);
          if (modelOverride) {
            model = applyModelOverride(model, modelOverride);
          }

          return model;
        });
      });
  }

  private loadCustomModels(modelsJsonPath: string): CustomModelsResult {
    if (!existsSync(modelsJsonPath)) {
      return emptyCustomModelsResult();
    }

    try {
      const content = readFileSync(modelsJsonPath, "utf-8");
      const config: ModelsConfig = JSON.parse(content);

      // Validate schema
      if (!validateModelsConfig.Check(config)) {
        const errors =
          validateModelsConfig
            .Errors(config)
            .map((e) => `  - ${e.instancePath || "root"}: ${e.message}`)
            .join("\n") || "Unknown schema error";
        return emptyCustomModelsResult(
          `Invalid models.json schema:\n${errors}\n\nFile: ${modelsJsonPath}`,
        );
      }

      // Additional validation
      this.validateConfig(config);

      const overrides = new Map<string, ProviderOverride>();
      const modelOverrides = new Map<string, Map<string, ModelOverride>>();

      for (const [providerName, providerConfig] of Object.entries(
        config.providers,
      )) {
        if (providerName.startsWith("cloudflare")) continue;
        if (providerConfig.baseUrl || providerConfig.compat) {
          overrides.set(providerName, {
            baseUrl: providerConfig.baseUrl,
            compat: providerConfig.compat,
          });
        }

        this.storeProviderRequestConfig(providerName, providerConfig);

        if (providerConfig.modelOverrides) {
          modelOverrides.set(
            providerName,
            new Map(Object.entries(providerConfig.modelOverrides)),
          );
          for (const [modelId, modelOverride] of Object.entries(
            providerConfig.modelOverrides,
          )) {
            this.storeModelHeaders(
              providerName,
              modelId,
              modelOverride.headers,
            );
          }
        }
      }

      return {
        error: undefined,
        modelOverrides,
        models: this.parseModels(config),
        overrides,
      };
    } catch (error) {
      if (error instanceof SyntaxError) {
        return emptyCustomModelsResult(
          `Failed to parse models.json: ${error.message}\n\nFile: ${modelsJsonPath}`,
        );
      }
      return emptyCustomModelsResult(
        `Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${modelsJsonPath}`,
      );
    }
  }

  private loadModels(): void {
    // Load custom models and overrides from models.json
    const {
      error,
      modelOverrides,
      models: customModels,
      overrides,
    } = this.modelsJsonPath
      ? this.loadCustomModels(this.modelsJsonPath)
      : emptyCustomModelsResult();

    if (error) {
      this.loadError = error;
      // Keep built-in models even if custom models failed to load
    }

    const builtInModels = this.loadBuiltInModels(overrides, modelOverrides);
    let combined = this.mergeCustomModels(builtInModels, customModels);

    this.models = combined;
  }

  /** Merge custom models into built-in list by provider+id (custom wins on conflicts). */
  private mergeCustomModels(
    builtInModels: Model<Api>[],
    customModels: Model<Api>[],
  ): Model<Api>[] {
    const merged = [...builtInModels];
    for (const customModel of customModels) {
      const existingIndex = merged.findIndex(
        (m) => m.provider === customModel.provider && m.id === customModel.id,
      );
      if (existingIndex >= 0) {
        merged[existingIndex] = customModel;
      } else {
        merged.push(customModel);
      }
    }
    return merged;
  }

  private parseModels(config: ModelsConfig): Model<Api>[] {
    const models: Model<Api>[] = [];

    for (const [providerName, providerConfig] of Object.entries(
      config.providers,
    )) {
      if (providerName.startsWith("cloudflare")) continue;
      const modelDefs = providerConfig.models ?? [];
      if (modelDefs.length === 0) continue; // Override-only, no custom models

      for (const modelDef of modelDefs) {
        const api = modelDef.api || providerConfig.api;
        if (!api) continue;

        const compat = mergeCompat(providerConfig.compat, modelDef.compat);
        this.storeModelHeaders(providerName, modelDef.id, modelDef.headers);

        // Provider baseUrl is required when custom models are defined.
        // Individual models can override it with modelDef.baseUrl.
        const defaultCost = {
          cacheRead: 0,
          cacheWrite: 0,
          input: 0,
          output: 0,
        };
        models.push({
          api: api as Api,
          baseUrl: modelDef.baseUrl ?? providerConfig.baseUrl!,
          compat,
          contextWindow: modelDef.contextWindow ?? 128000,
          cost: modelDef.cost ?? defaultCost,
          headers: undefined,
          id: modelDef.id,
          input: (modelDef.input ?? ["text"]) as ("image" | "text")[],
          maxTokens: modelDef.maxTokens ?? 16384,
          name: modelDef.name ?? modelDef.id,
          provider: providerName,
          reasoning: modelDef.reasoning ?? false,
        } as Model<Api>);
      }
    }

    return models;
  }

  private storeModelHeaders(
    providerName: string,
    modelId: string,
    headers?: Record<string, string>,
  ): void {
    const key = this.getModelRequestKey(providerName, modelId);
    if (!headers || Object.keys(headers).length === 0) {
      this.modelRequestHeaders.delete(key);
      return;
    }
    this.modelRequestHeaders.set(key, headers);
  }

  private storeProviderRequestConfig(
    providerName: string,
    config: {
      apiKey?: string;
      authHeader?: boolean;
      headers?: Record<string, string>;
    },
  ): void {
    if (!config.apiKey && !config.headers && !config.authHeader) {
      return;
    }

    this.providerRequestConfigs.set(providerName, {
      apiKey: config.apiKey,
      authHeader: config.authHeader,
      headers: config.headers,
    });
  }

  private validateConfig(config: ModelsConfig): void {
    for (const [providerName, providerConfig] of Object.entries(
      config.providers,
    )) {
      const hasProviderApi = !!providerConfig.api;
      const models = providerConfig.models ?? [];
      const hasModelOverrides =
        providerConfig.modelOverrides &&
        Object.keys(providerConfig.modelOverrides).length > 0;

      if (models.length === 0) {
        // Override-only config: needs baseUrl, compat, modelOverrides, or some combination.
        if (
          !providerConfig.baseUrl &&
          !providerConfig.compat &&
          !hasModelOverrides
        ) {
          throw new Error(
            `Provider ${providerName}: must specify "baseUrl", "compat", "modelOverrides", or "models".`,
          );
        }
      } else {
        // Custom models are merged into provider models and require endpoint + auth.
        if (!providerConfig.baseUrl) {
          throw new Error(
            `Provider ${providerName}: "baseUrl" is required when defining custom models.`,
          );
        }
        if (!providerConfig.apiKey) {
          throw new Error(
            `Provider ${providerName}: "apiKey" is required when defining custom models.`,
          );
        }
      }

      for (const modelDef of models) {
        const hasModelApi = !!modelDef.api;

        if (!hasProviderApi && !hasModelApi) {
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: no "api" specified. Set at provider or model level.`,
          );
        }

        if (!modelDef.id)
          throw new Error(`Provider ${providerName}: model missing "id"`);
        // Validate contextWindow/maxTokens only if provided (they have defaults)
        if (modelDef.contextWindow !== undefined && modelDef.contextWindow <= 0)
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: invalid contextWindow`,
          );
        if (modelDef.maxTokens !== undefined && modelDef.maxTokens <= 0)
          throw new Error(
            `Provider ${providerName}, model ${modelDef.id}: invalid maxTokens`,
          );
      }
    }
  }

  private validateProviderConfig(
    providerName: string,
    config: ProviderConfigInput,
  ): void {
    if (config.streamSimple && !config.api) {
      throw new Error(
        `Provider ${providerName}: "api" is required when registering streamSimple.`,
      );
    }

    if (!config.models || config.models.length === 0) {
      return;
    }

    if (!config.baseUrl) {
      throw new Error(
        `Provider ${providerName}: "baseUrl" is required when defining models.`,
      );
    }
    if (!config.apiKey) {
      throw new Error(
        `Provider ${providerName}: "apiKey" is required when defining models.`,
      );
    }

    for (const modelDef of config.models) {
      const api = modelDef.api || config.api;
      if (!api) {
        throw new Error(
          `Provider ${providerName}, model ${modelDef.id}: no "api" specified.`,
        );
      }
    }
  }
}
