import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@shiit/agent-core";

import { join } from "node:path";

import type { SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import type { SessionManager } from "./session-manager.js";

import { getAgentDir } from "../config.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import {
  DefaultResourceLoader,
  type DefaultResourceLoaderOptions,
  type ResourceLoader,
} from "./resource-loader.js";
import { createAgentSession, type CreateAgentSessionResult } from "./sdk.js";
import { SettingsManager } from "./settings-manager.js";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
  message: string;
  type: "error" | "info" | "warning";
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
  agentDir: string;
  authStorage: AuthStorage;
  cwd: string;
  diagnostics: AgentSessionRuntimeDiagnostic[];
  modelRegistry: ModelRegistry;
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
  model?: Model<any>;
  onPayload?: SimpleStreamOptions["onPayload"];
  scopedModels?: { model: Model<any>; thinkingLevel?: ThinkingLevel }[];
  services: AgentSessionServices;
  sessionManager: SessionManager;
  sessionStartEvent?: SessionStartEvent;
  thinkingLevel?: ThinkingLevel;
  /**
   * Initial SDK tools. Optional — defaults to `[]`. The session
   * runtime reads this synchronously to decide whether to spin up
   * an `ExtensionRunner`. Fetched once by the caller before
   * construction.
   */
  tools?: ToolDefinition[];
  /**
   * Live tool provider. See `CreateAgentSessionOptions.toolsProvider`
   * and PLAN-016 PR 3.
   */
  toolsProvider?: () => Promise<ToolDefinition[]>;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
  agentDir?: string;
  authStorage?: AuthStorage;
  cwd: string;
  extensionFlagValues?: Map<string, boolean | string>;
  modelRegistry?: ModelRegistry;
  resourceLoaderOptions?: Omit<
    DefaultResourceLoaderOptions,
    "agentDir" | "cwd" | "settingsManager"
  >;
  settingsManager?: SettingsManager;
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
  options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
  return createAgentSession({
    agentDir: options.services.agentDir,
    authStorage: options.services.authStorage,
    cwd: options.services.cwd,
    model: options.model,
    modelRegistry: options.services.modelRegistry,
    onPayload: options.onPayload,
    resourceLoader: options.services.resourceLoader,
    scopedModels: options.scopedModels,
    sessionManager: options.sessionManager,
    sessionStartEvent: options.sessionStartEvent,
    settingsManager: options.services.settingsManager,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools ?? [],
    toolsProvider: options.toolsProvider,
  });
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
  options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
  const cwd = options.cwd;
  const agentDir = options.agentDir ?? getAgentDir();
  const authStorage =
    options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
  const settingsManager =
    options.settingsManager ?? SettingsManager.create(cwd, agentDir);
  const modelRegistry =
    options.modelRegistry ??
    ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const resourceLoader = new DefaultResourceLoader({
    ...(options.resourceLoaderOptions ?? {}),
    agentDir,
    cwd,
    settingsManager,
  });
  await resourceLoader.reload();

  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const extensionsResult = resourceLoader.getExtensions();
  for (const { config, extensionPath, name } of extensionsResult.runtime
    .pendingProviderRegistrations) {
    try {
      modelRegistry.registerProvider(name, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        message: `Extension "${extensionPath}" error: ${message}`,
        type: "error",
      });
    }
  }
  extensionsResult.runtime.pendingProviderRegistrations = [];
  diagnostics.push(
    ...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues),
  );

  return {
    agentDir,
    authStorage,
    cwd,
    diagnostics,
    modelRegistry,
    resourceLoader,
    settingsManager,
  };
}

function applyExtensionFlagValues(
  resourceLoader: ResourceLoader,
  extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
  if (!extensionFlagValues) {
    return [];
  }

  const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
  const extensionsResult = resourceLoader.getExtensions();
  const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
  for (const extension of extensionsResult.extensions) {
    for (const [name, flag] of extension.flags) {
      registeredFlags.set(name, { type: flag.type });
    }
  }

  const unknownFlags: string[] = [];
  for (const [name, value] of extensionFlagValues) {
    const flag = registeredFlags.get(name);
    if (!flag) {
      unknownFlags.push(name);
      continue;
    }
    if (flag.type === "boolean") {
      extensionsResult.runtime.flagValues.set(name, true);
      continue;
    }
    if (typeof value === "string") {
      extensionsResult.runtime.flagValues.set(name, value);
      continue;
    }
    diagnostics.push({
      message: `Extension flag "--${name}" requires a value`,
      type: "error",
    });
  }

  if (unknownFlags.length > 0) {
    diagnostics.push({
      message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
      type: "error",
    });
  }

  return diagnostics;
}
