import {
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
} from "@earendil-works/pi-ai/compat";
import {
  Agent,
  type AgentMessage,
  type ThinkingLevel,
} from "@shiit/agent-core";
import { join } from "node:path";

import type {
  ExtensionRunner,
  LoadExtensionsResult,
  SessionStartEvent,
  ToolDefinition,
} from "./extensions/index.js";
import type { ResourceLoader } from "./resource-loader.js";

import { getAgentDir, getDocsPath } from "../config.js";
import {
  type AgentLogger,
  AgentSession,
  ConsoleLogger,
} from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { findInitialModel } from "./model-resolver.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { getDefaultSessionDir, SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { time } from "./timings.js";

export interface CreateAgentSessionOptions {
  /** Global config directory. Default: ~/.pi/agent */
  agentDir?: string;
  /** Auth storage for credentials. Default: AuthStorage.create(agentDir/auth.json) */
  authStorage?: AuthStorage;

  /** Working directory for project-local discovery. Default: process.cwd() */
  cwd?: string;
  /** Logger for observability. Default: ConsoleLogger (logs to console in CF Workers). */
  logger?: AgentLogger;

  /** Model to use. Default: from settings, else first available */
  model?: Model<any>;
  /** Model registry. Default: ModelRegistry.create(authStorage, agentDir/models.json) */
  modelRegistry?: ModelRegistry;
  /** Optional callback for inspecting or replacing provider payloads before sending. */
  onPayload?: SimpleStreamOptions["onPayload"];

  /** Resource loader. When omitted, DefaultResourceLoader is used. */
  resourceLoader?: ResourceLoader;

  /** Models available for cycling (Ctrl+P in interactive mode) */
  scopedModels?: { model: Model<any>; thinkingLevel?: ThinkingLevel }[];

  /** Session manager. Default: SessionManager.create(cwd) */
  sessionManager?: SessionManager;

  /** Session start event metadata for extension runtime startup. */
  sessionStartEvent?: SessionStartEvent;
  /** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
  settingsManager?: SettingsManager;
  /** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
  thinkingLevel?: ThinkingLevel;
  /**
   * Initial SDK tools (file tools, bash, etc.). Optional — defaults
   * to `[]`. The runtime reads this synchronously to decide whether
   * to spin up an `ExtensionRunner`. Fetched once by the caller
   * before construction. The api worker reads the initial workspace
   * list once and passes the resulting tools here.
   */
  tools?: ToolDefinition[];
  /**
   * Provider for SDK tools. Called on every tool-registry refresh
   * so callers can swap tools in place without destroying the
   * session. Replaces the previous frozen `tools` array. PLAN-016
   * PR 3 + the async follow-up that made the provider
   * `Promise`-returning so it can fetch fresh per-workspace state.
   */
  toolsProvider?: () => Promise<ToolDefinition[]>;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
  /** Extensions result (for UI context setup in interactive mode) */
  extensionsResult: LoadExtensionsResult;
  /** Warning if session was restored with a different model than saved */
  modelFallbackMessage?: string;
  /** The created session */
  session: AgentSession;
}

// Re-exports

export * from "./agent-session-runtime.js";
export type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
  SlashCommandInfo,
  SlashCommandSource,
  ToolDefinition,
} from "./extensions/index.js";
export type { PromptTemplate } from "./prompt-templates.js";
export type { Skill } from "./skills.js";

// Helper Functions

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   toolsProvider: () => [readTool, bashTool],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(
  options: CreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getDefaultAgentDir();
  let resourceLoader = options.resourceLoader;

  // Use provided or create AuthStorage and ModelRegistry
  const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
  const modelsPath = options.agentDir
    ? join(agentDir, "models.json")
    : undefined;
  const authStorage = options.authStorage ?? AuthStorage.create(authPath);
  const modelRegistry =
    options.modelRegistry ?? ModelRegistry.create(authStorage, modelsPath);

  const settingsManager =
    options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const sessionManager =
    options.sessionManager ??
    SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

  if (!resourceLoader) {
    resourceLoader = new DefaultResourceLoader({
      agentDir,
      cwd,
      settingsManager,
    });
    await resourceLoader.reload();
    time("resourceLoader.reload");
  }

  // Check if session has existing data to restore
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager
    .getBranch()
    .some((entry) => entry.type === "thinking_level_change");

  let model = options.model;
  let modelFallbackMessage: string | undefined;

  // If session has data, try to restore model from it
  if (!model && hasExistingSession && existingSession.model) {
    const restoredModel = modelRegistry.find(
      existingSession.model.provider,
      existingSession.model.modelId,
    );
    if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
      model = restoredModel;
    }
    if (!model) {
      modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
    }
  }

  // If still no model, use findInitialModel (checks settings default, then provider defaults)
  if (!model) {
    const result = await findInitialModel({
      defaultModelId: settingsManager.getDefaultModel(),
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      isContinuing: hasExistingSession,
      modelRegistry,
      scopedModels: [],
    });
    model = result.model;
    if (!model) {
      modelFallbackMessage = `No models available. Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}. Then use /model to select a model.`;
    } else if (modelFallbackMessage) {
      modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
    }
  }

  let thinkingLevel = options.thinkingLevel;

  // If session has data, restore thinking level from it
  if (thinkingLevel === undefined && hasExistingSession) {
    thinkingLevel = hasThinkingEntry
      ? (existingSession.thinkingLevel as ThinkingLevel)
      : (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
  }

  // Fall back to settings default
  if (thinkingLevel === undefined) {
    thinkingLevel =
      settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
  }

  // Clamp to model capabilities
  if (!model || !model.reasoning) {
    thinkingLevel = "off";
  }

  let agent: Agent;

  // Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
  const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
    const converted = convertToLlm(messages);
    // Check setting dynamically so mid-session changes take effect
    if (!settingsManager.getBlockImages()) {
      return converted;
    }
    // Filter out ImageContent from all messages, replacing with text placeholder
    return converted.map((msg) => {
      if (msg.role === "user" || msg.role === "toolResult") {
        const content = msg.content;
        if (Array.isArray(content)) {
          const hasImages = content.some((c) => c.type === "image");
          if (hasImages) {
            const filteredContent = content
              .map((c) =>
                c.type === "image"
                  ? {
                      text: "Image reading is disabled.",
                      type: "text" as const,
                    }
                  : c,
              )
              .filter(
                (c, i, arr) =>
                  // Dedupe consecutive "Image reading is disabled." texts
                  !(
                    c.type === "text" &&
                    c.text === "Image reading is disabled." &&
                    i > 0 &&
                    arr[i - 1].type === "text" &&
                    (arr[i - 1] as { text: string; type: "text" }).text ===
                      "Image reading is disabled."
                  ),
              );
            return { ...msg, content: filteredContent };
          }
        }
      }
      return msg;
    });
  };

  const extensionRunnerRef: { current?: ExtensionRunner } = {};

  agent = new Agent({
    convertToLlm: convertToLlmWithBlockImages,
    followUpMode: settingsManager.getFollowUpMode(),
    initialState: {
      model,
      systemPrompt: "",
      thinkingLevel,
      tools: [],
    },
    maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
    onPayload: async (payload, model) => {
      let result = payload;
      if (options.onPayload) {
        result = (await options.onPayload(result, model)) ?? result;
      }
      const runner = extensionRunnerRef.current;
      if (!runner?.hasHandlers("before_provider_request")) {
        return result;
      }
      return runner.emitBeforeProviderRequest(result);
    },
    sessionId: sessionManager.getSessionId(),
    steeringMode: settingsManager.getSteeringMode(),
    streamFn: async (model, context, options) => {
      const auth = await modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      const providerRetrySettings = settingsManager.getProviderRetrySettings();
      return streamSimple(model, context, {
        ...options,
        apiKey: auth.apiKey,
        headers:
          auth.headers || options?.headers
            ? { ...auth.headers, ...options?.headers }
            : undefined,
        sessionId: sessionManager.getSessionId(),
        timeoutMs: options?.timeoutMs ?? providerRetrySettings.timeoutMs,
        maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
        maxRetryDelayMs:
          options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
      });
    },
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    transformContext: async (messages) => {
      const runner = extensionRunnerRef.current;
      if (!runner) return messages;
      return runner.emitContext(messages);
    },
    transport: settingsManager.getTransport(),
  });

  // Restore messages if session has existing data
  if (hasExistingSession) {
    agent.state.messages = existingSession.messages;
    if (!hasThinkingEntry) {
      sessionManager.appendThinkingLevelChange(thinkingLevel);
    }
  } else {
    // Save initial model and thinking level for new sessions so they can be restored on resume
    if (model) {
      sessionManager.appendModelChange(model.provider, model.id);
    }
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  const session = new AgentSession({
    agent,
    cwd,
    extensionRunnerRef,
    logger: options.logger ?? new ConsoleLogger(),
    modelRegistry,
    resourceLoader,
    scopedModels: options.scopedModels,
    sessionManager,
    sessionStartEvent: options.sessionStartEvent,
    settingsManager,
    tools: options.tools ?? [],
    toolsProvider: options.toolsProvider,
  });
  const extensionsResult = resourceLoader.getExtensions();

  return {
    extensionsResult,
    modelFallbackMessage,
    session,
  };
}

function getDefaultAgentDir(): string {
  return getAgentDir();
}
