/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
} from "@mariozechner/pi-ai";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "@shiit/agent-core";

import {
  getSupportedThinkingLevels,
  isContextOverflow,
  modelsAreEqual,
  resetApiProviders,
} from "@mariozechner/pi-ai";
import { nanoid } from "@shiit/id";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ResourceDiagnostic } from "./diagnostics.js";
import type { CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import type {
  ResourceExtensionPaths,
  ResourceLoader,
} from "./resource-loader.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionManager,
} from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SlashCommandInfo } from "./slash-commands.js";

import { getDocsPath } from "../config.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import {
  calculateContextTokens,
  collectEntriesForBranchSummary,
  compact,
  type CompactionResult,
  estimateContextTokens,
  generateBranchSummary,
  prepareCompaction,
  shouldCompact,
} from "./compaction/index.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import {
  type ContextUsage,
  type ExtensionCommandContextActions,
  type ExtensionErrorListener,
  ExtensionRunner,
  type ExtensionUIContext,
  type InputSource,
  type MessageEndEvent,
  type MessageStartEvent,
  type MessageUpdateEvent,
  type SessionBeforeCompactResult,
  type SessionBeforeTreeResult,
  type SessionStartEvent,
  type ShutdownHandler,
  type ToolDefinition,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolInfo,
  type TreePreparation,
  type TurnEndEvent,
  type TurnStartEvent,
  wrapRegisteredTools,
} from "./extensions/index.js";
import {
  expandPromptTemplate,
  type PromptTemplate,
} from "./prompt-templates.js";
import {
  CURRENT_SESSION_VERSION,
  getLatestCompactionEntry,
  type SessionHeader,
} from "./session-manager.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { buildSystemPrompt } from "./system-prompt.js";

// ============================================================================
// Skill Block Parsing
// ============================================================================

export interface AgentLogger {
  debug(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>, error?: Error): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
}

export interface AgentSessionConfig {
  agent: Agent;
  cwd: string;
  /** Mutable ref used by Agent to access the current ExtensionRunner */
  extensionRunnerRef?: { current?: ExtensionRunner };
  /** Injectable logger for observability. Defaults to NoOpLogger (silent). */
  logger?: AgentLogger;
  /** Model registry for API key resolution and model discovery */
  modelRegistry: ModelRegistry;
  /** Resource loader for skills, prompts, themes, context files, system prompt */
  resourceLoader: ResourceLoader;
  /** Models to cycle through with Ctrl+P (from --models flag) */
  scopedModels?: { model: Model<any>; thinkingLevel?: ThinkingLevel }[];
  sessionManager: SessionManager;
  /** Session start event metadata emitted when extensions bind to this runtime. */
  sessionStartEvent?: SessionStartEvent;
  settingsManager: SettingsManager;
  /** Tools provided by the environment (file tools, bash, etc.) */
  tools?: ToolDefinition[];
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
  | {
      aborted: boolean;
      errorMessage?: string;
      reason: "manual" | "overflow" | "threshold";
      result: CompactionResult | undefined;
      type: "compaction_end";
      willRetry: boolean;
    }
  | {
      activeToolNames: readonly string[];
      type: "tools_changed";
    }
  | {
      attempt: number;
      delayMs: number;
      errorMessage: string;
      maxAttempts: number;
      type: "auto_retry_start";
    }
  | {
      attempt: number;
      finalError?: string;
      success: boolean;
      type: "auto_retry_end";
    }
  | {
      availableLevels: ThinkingLevel[];
      level: ThinkingLevel;
      type: "thinking_level_changed";
    }
  | {
      delta: string;
      id: string;
      message: AgentMessage;
      thinkingDelta?: string;
      type: "message_update";
    }
  | {
      extensionErrors: { error: string; path: string }[];
      extensions: { path: string; sourceInfo?: SourceInfo }[];
      promptDiagnostics: ResourceDiagnostic[];
      prompts: {
        filePath: string;
        name: string;
        sourceInfo?: SourceInfo;
      }[];
      skillDiagnostics: ResourceDiagnostic[];
      skills: {
        filePath: string;
        name: string;
        sourceInfo?: SourceInfo;
      }[];
      themeDiagnostics: ResourceDiagnostic[];
      themes: {
        name: string;
        sourceInfo?: SourceInfo;
        sourcePath?: string;
      }[];
      type: "resources_changed";
    }
  | {
      followUp: readonly string[];
      steering: readonly string[];
      type: "queue_update";
    }
  | {
      fromExtension?: boolean;
      newLeafId: null | string;
      oldLeafId: null | string;
      summaryEntry?: BranchSummaryEntry;
      type: "tree_changed";
    }
  | {
      id: string;
      message: AgentMessage;
      type: "message_end";
    }
  | {
      id: string;
      message: AgentMessage;
      type: "message_start";
    }
  | {
      label: string | undefined;
      targetId: string;
      type: "label_changed";
    }
  | {
      model: Model<any> | undefined;
      previousModel: Model<any> | undefined;
      source: "cycle" | "restore" | "set";
      type: "model_changed";
    }
  | { reason: "manual" | "overflow" | "threshold"; type: "compaction_start" }
  | {
      sessionName?: string;
      type: "session_metadata_changed";
    }
  | {
      cost?: number;
      type: "context_usage_changed";
      usage: ContextUsage | undefined;
    }
  | AgentEvent;

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Logger
// ============================================================================

export interface ExtensionBindings {
  commandContextActions?: ExtensionCommandContextActions;
  onError?: ExtensionErrorListener;
  shutdownHandler?: ShutdownHandler;
  uiContext?: ExtensionUIContext;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
  /** Whether cycling through scoped models (--models flag) or all available */
  isScoped: boolean;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
}

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
  content: string;
  location: string;
  name: string;
  userMessage: string | undefined;
}

export { ConsoleLogger, NoOpLogger };

// ============================================================================
// Types
// ============================================================================

/** Options for AgentSession.prompt() */
export interface PromptOptions {
  /** Whether to expand file-based prompt templates (default: true) */
  expandPromptTemplates?: boolean;
  /** Image attachments */
  images?: ImageContent[];
  /** Source of input for extension input event handlers. Defaults to "interactive". */
  source?: InputSource;
  /** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
  streamingBehavior?: "followUp" | "steer";
}

/** Session statistics for /session command */
export interface SessionStats {
  assistantMessages: number;
  contextUsage?: ContextUsage;
  cost: number;
  sessionFile: string | undefined;
  sessionId: string;
  tokens: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    total: number;
  };
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  userMessages: number;
}

interface ToolDefinitionEntry {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

class ConsoleLogger implements AgentLogger {
  debug(_event: string, _data?: Record<string, unknown>) {
    // no-op: deep-debug logs retired 2026-06-02. Re-enable here when the next
    // deep agent bug surfaces — the call sites are intact.
  }
  error(event: string, data?: Record<string, unknown>, error?: Error) {
    console.error(
      `[ERROR] ${event}`,
      error?.stack ?? "",
      data ? JSON.stringify(data) : "",
    );
  }
  info(event: string, data?: Record<string, unknown>) {
    console.log(`[INFO] ${event}`, data ? JSON.stringify(data) : "");
  }
  warn(event: string, data?: Record<string, unknown>) {
    console.warn(`[WARN] ${event}`, data ? JSON.stringify(data) : "");
  }
}

class NoOpLogger implements AgentLogger {
  debug() {}
  error() {}
  info() {}
  warn() {}
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): null | ParsedSkillBlock {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return null;
  return {
    content: match[3],
    location: match[2],
    name: match[1],
    userMessage: match[4]?.trim() || undefined,
  };
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

/** Thinking levels including xhigh (for supported models) */
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }

  /** Whether auto-retry is enabled */
  get autoRetryEnabled(): boolean {
    return this.settingsManager.getRetryEnabled();
  }
  /**
   * Get the extension runner (for setting UI context and error handlers).
   */
  get extensionRunner(): ExtensionRunner | undefined {
    return this._extensionRunner;
  }
  /** Current follow-up mode */
  get followUpMode(): "all" | "one-at-a-time" {
    return this.agent.followUpMode;
  }

  /** Whether compaction or branch summarization is currently running */
  get isCompacting(): boolean {
    return (
      this._autoCompactionAbortController !== undefined ||
      this._compactionAbortController !== undefined ||
      this._branchSummaryAbortController !== undefined
    );
  }
  /** Whether auto-retry is currently in progress */
  get isRetrying(): boolean {
    return this._retryPromise !== undefined;
  }
  /** Whether agent is currently streaming a response */
  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /** All messages including custom types */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }
  /** Current model (may be undefined if not yet selected) */
  get model(): Model<any> | undefined {
    return this.agent.state.model;
  }
  /** Model registry for API key resolution and model discovery */
  get modelRegistry(): ModelRegistry {
    return this._modelRegistry;
  }

  /** Number of pending messages (includes both steering and follow-up) */
  get pendingMessageCount(): number {
    return this._steeringMessages.length + this._followUpMessages.length;
  }

  /** File-based prompt templates */
  get promptTemplates(): readonly PromptTemplate[] {
    return this._resourceLoader.getPrompts().prompts;
  }
  get resourceLoader(): ResourceLoader {
    return this._resourceLoader;
  }
  /** Current retry attempt (0 if not retrying) */
  get retryAttempt(): number {
    return this._retryAttempt;
  }
  /** Scoped models for cycling (from --models flag) */
  get scopedModels(): readonly {
    model: Model<any>;
    thinkingLevel?: ThinkingLevel;
  }[] {
    return this._scopedModels;
  }

  /** Current session file path, or undefined if sessions are disabled */
  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }
  /** Current session ID */
  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  /** Current session display name, if set */
  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName();
  }
  /** ID of the currently streaming message, so snapshots can match live events. */
  get currentMessageId(): string | undefined {
    return this._currentMessageId;
  }
  /** Full agent state */
  get state(): AgentState {
    return this.agent.state;
  }
  /** Current steering mode */
  get steeringMode(): "all" | "one-at-a-time" {
    return this.agent.steeringMode;
  }
  /** Current effective system prompt (includes any per-turn extension modifications) */
  get systemPrompt(): string {
    return this.agent.state.systemPrompt;
  }
  /** Current thinking level */
  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }
  private _agentEventQueue: Promise<void> = Promise.resolve();
  private _autoCompactionAbortController: AbortController | undefined =
    undefined;
  // Base system prompt (without extension appends) - used to apply fresh appends each turn
  private _baseSystemPrompt = "";
  /** ID of the currently streaming message (from agent events), for snapshot alignment. */
  private _currentMessageId?: string;
  // Branch summarization state
  private _branchSummaryAbortController: AbortController | undefined =
    undefined;
  // Compaction state
  private _compactionAbortController: AbortController | undefined = undefined;

  private _cwd: string;

  private _eventListeners: AgentSessionEventListener[] = [];
  private _extensionCommandContextActions?: ExtensionCommandContextActions;
  private _extensionErrorListener?: ExtensionErrorListener;
  private _extensionErrorUnsubscriber?: () => void;

  // Extension system
  private _extensionRunner: ExtensionRunner | undefined = undefined;

  private _extensionRunnerRef?: { current?: ExtensionRunner };

  private _extensionShutdownHandler?: ShutdownHandler;

  private _extensionUIContext?: ExtensionUIContext;

  /** Tracks pending follow-up messages for UI display. Removed when delivered. */
  private _followUpMessages: string[] = [];

  // Track last assistant message for auto-compaction check
  private _lastAssistantMessage: AssistantMessage | undefined = undefined;

  // =========================================================================
  // Event Subscription
  // =========================================================================

  private _logger: AgentLogger;

  // Model registry for API key resolution
  private _modelRegistry: ModelRegistry;

  private _overflowRecoveryAttempted = false;

  /** Messages queued to be included with the next user prompt as context ("asides"). */
  private _pendingNextTurnMessages: CustomMessage[] = [];

  private _resourceLoader: ResourceLoader;

  // Retry state
  private _retryAbortController: AbortController | undefined = undefined;

  private _retryAttempt = 0;

  private _retryPromise: Promise<void> | undefined = undefined;

  private _retryResolve: (() => void) | undefined = undefined;

  private _scopedModels: {
    model: Model<any>;
    thinkingLevel?: ThinkingLevel;
  }[];

  private _sessionStartEvent: SessionStartEvent;

  /** Tracks pending steering messages for UI display. Removed when delivered. */
  private _steeringMessages: string[] = [];

  private _toolDefinitions = new Map<string, ToolDefinitionEntry>();

  private _toolPromptGuidelines = new Map<string, string[]>();

  // =========================================================================
  // Read-only State Access
  // =========================================================================

  private _toolPromptSnippets = new Map<string, string>();

  // Tool registry for extension getTools/setTools
  private _toolRegistry = new Map<string, AgentTool>();

  private _tools: ToolDefinition[];

  private _turnIndex = 0;

  // Event subscription state
  private _unsubscribeAgent?: () => void;

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this._scopedModels = config.scopedModels ?? [];
    this._resourceLoader = config.resourceLoader;
    this._tools = config.tools ?? [];
    this._cwd = config.cwd;
    this._modelRegistry = config.modelRegistry;
    this._extensionRunnerRef = config.extensionRunnerRef;
    this._sessionStartEvent = config.sessionStartEvent ?? {
      reason: "startup",
      type: "session_start",
    };
    this._logger = config.logger ?? new NoOpLogger();

    // Always subscribe to agent events for internal handling
    // (session persistence, extensions, auto-compaction, retry logic)
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
    this._installAgentToolHooks();

    this._buildRuntime({
      includeAllExtensionTools: true,
    });
  }

  /**
   * Abort current operation and wait for agent to become idle.
   */
  async abort(): Promise<void> {
    this.abortRetry();
    this.agent.abort();
    await this.agent.waitForIdle();
  }

  /**
   * Cancel in-progress branch summarization.
   */
  abortBranchSummary(): void {
    this._branchSummaryAbortController?.abort();
  }

  /**
   * Cancel in-progress compaction (manual or auto).
   */
  abortCompaction(): void {
    this._compactionAbortController?.abort();
    this._autoCompactionAbortController?.abort();
  }

  /**
   * Cancel in-progress retry.
   */
  abortRetry(): void {
    this._retryAbortController?.abort();
    // Note: _retryAttempt is reset in the catch block of _autoRetry
    this._resolveRetry();
  }

  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
    if (bindings.uiContext !== undefined) {
      this._extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== undefined) {
      this._extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.shutdownHandler !== undefined) {
      this._extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== undefined) {
      this._extensionErrorListener = bindings.onError;
    }

    if (this._extensionRunner) {
      this._applyExtensionBindings(this._extensionRunner);
      await this._extensionRunner.emit(this._sessionStartEvent);
      await this.extendResourcesFromExtensions(
        this._sessionStartEvent.reason === "reload" ? "reload" : "startup",
      );
    }
  }

  /**
   * Clear all queued messages and return them.
   * Useful for restoring to editor when user aborts.
   * @returns Object with steering and followUp arrays
   */
  clearQueue(): { followUp: string[]; steering: string[] } {
    const steering = [...this._steeringMessages];
    const followUp = [...this._followUpMessages];
    this._steeringMessages = [];
    this._followUpMessages = [];
    this.agent.clearAllQueues();
    this._emitQueueUpdate();
    return { followUp, steering };
  }

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    this._disconnectFromAgent();
    await this.abort();
    this._compactionAbortController = new AbortController();
    this._emit({ reason: "manual", type: "compaction_start" });

    try {
      if (!this.model) {
        throw new Error("No model selected");
      }

      const { apiKey, headers } = await this._getRequiredRequestAuth(
        this.model,
      );

      const pathEntries = this.sessionManager.getBranch();
      const settings = this.settingsManager.getCompactionSettings();

      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        // Check why we can't compact
        const lastEntry = pathEntries[pathEntries.length - 1];
        if (lastEntry?.type === "compaction") {
          throw new Error("Already compacted");
        }
        throw new Error("Nothing to compact (session too small)");
      }

      let extensionCompaction: CompactionResult | undefined;
      let fromExtension = false;

      if (this._extensionRunner?.hasHandlers("session_before_compact")) {
        const result = (await this._extensionRunner.emit({
          branchEntries: pathEntries,
          customInstructions,
          preparation,
          signal: this._compactionAbortController.signal,
          type: "session_before_compact",
        })) as SessionBeforeCompactResult | undefined;

        if (result?.cancel) {
          throw new Error("Compaction cancelled");
        }

        if (result?.compaction) {
          extensionCompaction = result.compaction;
          fromExtension = true;
        }
      }

      let summary: string;
      let firstKeptEntryId: string;
      let tokensBefore: number;
      let details: unknown;

      if (extensionCompaction) {
        // Extension provided compaction content
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        // Generate compaction result
        const result = await compact(
          preparation,
          this.model,
          apiKey,
          headers,
          customInstructions,
          this._compactionAbortController.signal,
        );
        summary = result.summary;
        firstKeptEntryId = result.firstKeptEntryId;
        tokensBefore = result.tokensBefore;
        details = result.details;
      }

      if (this._compactionAbortController.signal.aborted) {
        throw new Error("Compaction cancelled");
      }

      this.sessionManager.appendCompaction(
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromExtension,
      );
      const newEntries = this.sessionManager.getEntries();
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.state.messages = sessionContext.messages;

      // Get the saved compaction entry for the extension event
      const savedCompactionEntry = newEntries.find(
        (e) => e.type === "compaction" && e.summary === summary,
      ) as CompactionEntry | undefined;

      if (this._extensionRunner && savedCompactionEntry) {
        await this._extensionRunner.emit({
          compactionEntry: savedCompactionEntry,
          fromExtension,
          type: "session_compact",
        });
      }

      const compactionResult = {
        details,
        firstKeptEntryId,
        summary,
        tokensBefore,
      };
      this._emit({
        aborted: false,
        reason: "manual",
        result: compactionResult,
        type: "compaction_end",
        willRetry: false,
      });
      return compactionResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        message === "Compaction cancelled" ||
        (error instanceof Error && error.name === "AbortError");
      this._emit({
        aborted,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
        reason: "manual",
        result: undefined,
        type: "compaction_end",
        willRetry: false,
      });
      throw error;
    } finally {
      this._compactionAbortController = undefined;
      this._reconnectToAgent();
    }
  }

  /**
   * Cycle to next/previous model.
   * Uses scoped models (from --models flag) if available, otherwise all available models.
   * @param direction - "forward" (default) or "backward"
   * @returns The new model info, or undefined if only one model available
   */
  async cycleModel(
    direction: "backward" | "forward" = "forward",
  ): Promise<ModelCycleResult | undefined> {
    if (this._scopedModels.length > 0) {
      return this._cycleScopedModel(direction);
    }
    return this._cycleAvailableModel(direction);
  }

  /**
   * Cycle to next thinking level.
   * @returns New level, or undefined if model doesn't support thinking
   */
  cycleThinkingLevel(): ThinkingLevel | undefined {
    if (!this.supportsThinking()) return undefined;

    const levels = this.getAvailableThinkingLevels();
    const currentIndex = levels.indexOf(this.thinkingLevel);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels[nextIndex];

    this.setThinkingLevel(nextLevel);
    return nextLevel;
  }

  /**
   * Remove all listeners and disconnect from agent.
   * Call this when completely done with the session.
   */
  dispose(): void {
    this._disconnectFromAgent();
    this._eventListeners = [];
  }

  /**
   * Export the current session branch to a JSONL file.
   * Writes the session header followed by all entries on the current branch path.
   * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
   * @returns The resolved output file path.
   */
  exportToJsonl(outputPath?: string): string {
    const filePath = resolve(
      outputPath ??
        `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    );
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const header: SessionHeader = {
      cwd: this.sessionManager.getCwd(),
      id: this.sessionManager.getSessionId(),
      timestamp: new Date().toISOString(),
      type: "session",
      version: CURRENT_SESSION_VERSION,
    };

    const branchEntries = this.sessionManager.getBranch();
    const lines = [JSON.stringify(header)];

    // Re-chain parentIds to form a linear sequence
    let prevId: null | string = null;
    for (const entry of branchEntries) {
      const linear = { ...entry, parentId: prevId };
      lines.push(JSON.stringify(linear));
      prevId = entry.id;
    }

    writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
  }

  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this._throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [
      ...this.promptTemplates,
    ]);

    await this._queueFollowUp(expandedText, images);
  }

  /**
   * Get the names of currently active tools.
   * Returns the names of tools currently set on the agent.
   */
  getActiveToolNames(): string[] {
    return this.agent.state.tools.map((t) => t.name);
  }

  /**
   * Get all configured tools with name, description, parameter schema, and source metadata.
   */
  getAllTools(): ToolInfo[] {
    return Array.from(this._toolDefinitions.values()).map(
      ({ definition, sourceInfo }) => ({
        description: definition.description,
        name: definition.name,
        parameters: definition.parameters,
        sourceInfo,
      }),
    );
  }

  /**
   * Get available thinking levels for current model.
   * The provider will clamp to what the specific model supports internally.
   */
  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.supportsThinking()) return ["off"];
    return this.supportsXhighThinking()
      ? THINKING_LEVELS_WITH_XHIGH
      : THINKING_LEVELS;
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) return undefined;

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;

    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);

    if (latestCompaction) {
      // Check if there's a valid assistant usage after the compaction boundary
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      let hasPostCompactionUsage = false;
      for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
        const entry = branchEntries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message;
          if (
            assistant.stopReason !== "aborted" &&
            assistant.stopReason !== "error"
          ) {
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
            }
            break;
          }
        }
      }

      if (!hasPostCompactionUsage) {
        return { contextWindow, percent: null, tokens: null };
      }
    }

    const estimate = estimateContextTokens(this.messages);
    const percent = (estimate.tokens / contextWindow) * 100;

    return {
      contextWindow,
      percent,
      tokens: estimate.tokens,
    };
  }

  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages(): readonly string[] {
    return this._followUpMessages;
  }

  // =========================================================================
  // Prompting
  // =========================================================================

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText(): string | undefined {
    const lastAssistant = this.messages
      .slice()
      .reverse()
      .find((m) => {
        if (m.role !== "assistant") return false;
        const msg = m as AssistantMessage;
        // Skip aborted messages with no content
        if (msg.stopReason === "aborted" && msg.content.length === 0)
          return false;
        return true;
      });

    if (!lastAssistant) return undefined;

    let text = "";
    for (const content of (lastAssistant as AssistantMessage).content) {
      if (content.type === "text") {
        text += content.text;
      }
    }

    return text.trim() || undefined;
  }

  /**
   * Get session statistics.
   */
  getSessionStats(): SessionStats {
    const state = this.state;
    const userMessages = state.messages.filter((m) => m.role === "user").length;
    const assistantMessages = state.messages.filter(
      (m) => m.role === "assistant",
    ).length;
    const toolResults = state.messages.filter(
      (m) => m.role === "toolResult",
    ).length;

    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const message of state.messages) {
      if (message.role === "assistant") {
        const assistantMsg = message as AssistantMessage;
        toolCalls += assistantMsg.content.filter(
          (c) => c.type === "toolCall",
        ).length;
        totalInput += assistantMsg.usage.input;
        totalOutput += assistantMsg.usage.output;
        totalCacheRead += assistantMsg.usage.cacheRead;
        totalCacheWrite += assistantMsg.usage.cacheWrite;
        totalCost += assistantMsg.usage.cost.total;
      }
    }

    return {
      assistantMessages,
      contextUsage: this.getContextUsage(),
      cost: totalCost,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      tokens: {
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        input: totalInput,
        output: totalOutput,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      },
      toolCalls,
      toolResults,
      totalMessages: state.messages.length,
      userMessages,
    };
  }

  /** Get pending steering messages (read-only) */
  getSteeringMessages(): readonly string[] {
    return this._steeringMessages;
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this._toolDefinitions.get(name)?.definition;
  }

  /**
   * Get all user messages from session for fork selector.
   */
  getUserMessagesForForking(): { entryId: string; text: string }[] {
    const entries = this.sessionManager.getEntries();
    const result: { entryId: string; text: string }[] = [];

    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message.role !== "user") continue;

      const text = this._extractUserMessageText(entry.message.content);
      if (text) {
        result.push({ entryId: entry.id, text });
      }
    }

    return result;
  }

  /**
   * Check if extensions have handlers for a specific event type.
   */
  hasExtensionHandlers(eventType: string): boolean {
    return this._extensionRunner?.hasHandlers(eventType) ?? false;
  }

  /**
   * Navigate to a different node in the session tree.
   * Unlike fork() which creates a new session file, this stays in the same file.
   *
   * @param targetId The entry ID to navigate to
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.customInstructions Custom instructions for summarizer
   * @param options.replaceInstructions If true, customInstructions replaces the default prompt
   * @param options.label Label to attach to the branch summary entry
   * @returns Result with editorText (if user message) and cancelled status
   */
  async navigateTree(
    targetId: string,
    options: {
      customInstructions?: string;
      label?: string;
      replaceInstructions?: boolean;
      summarize?: boolean;
    } = {},
  ): Promise<{
    aborted?: boolean;
    cancelled: boolean;
    editorText?: string;
    summaryEntry?: BranchSummaryEntry;
  }> {
    const oldLeafId = this.sessionManager.getLeafId();

    // No-op if already at target
    if (targetId === oldLeafId) {
      return { cancelled: false };
    }

    // Model required for summarization
    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization");
    }

    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }

    // Collect entries to summarize (from old leaf to common ancestor)
    const { commonAncestorId, entries: entriesToSummarize } =
      collectEntriesForBranchSummary(this.sessionManager, oldLeafId, targetId);

    // Prepare event data - mutable so extensions can override
    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;

    const preparation: TreePreparation = {
      commonAncestorId,
      customInstructions,
      entriesToSummarize,
      label,
      oldLeafId,
      replaceInstructions,
      targetId,
      userWantsSummary: options.summarize ?? false,
    };

    // Set up abort controller for summarization
    this._branchSummaryAbortController = new AbortController();
    let extensionSummary: { details?: unknown; summary: string } | undefined;
    let fromExtension = false;

    // Emit session_before_tree event
    if (this._extensionRunner?.hasHandlers("session_before_tree")) {
      const result = (await this._extensionRunner.emit({
        preparation,
        signal: this._branchSummaryAbortController.signal,
        type: "session_before_tree",
      })) as SessionBeforeTreeResult | undefined;

      if (result?.cancel) {
        return { cancelled: true };
      }

      if (result?.summary && options.summarize) {
        extensionSummary = result.summary;
        fromExtension = true;
      }

      // Allow extensions to override instructions and label
      if (result?.customInstructions !== undefined) {
        customInstructions = result.customInstructions;
      }
      if (result?.replaceInstructions !== undefined) {
        replaceInstructions = result.replaceInstructions;
      }
      if (result?.label !== undefined) {
        label = result.label;
      }
    }

    // Run default summarizer if needed
    let summaryText: string | undefined;
    let summaryDetails: unknown;
    if (
      options.summarize &&
      entriesToSummarize.length > 0 &&
      !extensionSummary
    ) {
      const model = this.model!;
      const { apiKey, headers } = await this._getRequiredRequestAuth(model);
      const branchSummarySettings =
        this.settingsManager.getBranchSummarySettings();
      const result = await generateBranchSummary(entriesToSummarize, {
        apiKey,
        customInstructions,
        headers,
        model,
        replaceInstructions,
        reserveTokens: branchSummarySettings.reserveTokens,
        signal: this._branchSummaryAbortController.signal,
      });
      this._branchSummaryAbortController = undefined;
      if (result.aborted) {
        return { aborted: true, cancelled: true };
      }
      if (result.error) {
        throw new Error(result.error);
      }
      summaryText = result.summary;
      summaryDetails = {
        modifiedFiles: result.modifiedFiles || [],
        readFiles: result.readFiles || [],
      };
    } else if (extensionSummary) {
      summaryText = extensionSummary.summary;
      summaryDetails = extensionSummary.details;
    }

    // Determine the new leaf position based on target type
    let newLeafId: null | string;
    let editorText: string | undefined;

    if (targetEntry.type === "message" && targetEntry.message.role === "user") {
      // User message: leaf = parent (null if root), text goes to editor
      newLeafId = targetEntry.parentId;
      editorText = this._extractUserMessageText(targetEntry.message.content);
    } else if (targetEntry.type === "custom_message") {
      // Custom message: leaf = parent (null if root), text goes to editor
      newLeafId = targetEntry.parentId;
      editorText =
        typeof targetEntry.content === "string"
          ? targetEntry.content
          : targetEntry.content
              .filter(
                (c): c is { text: string; type: "text" } => c.type === "text",
              )
              .map((c) => c.text)
              .join("");
    } else {
      // Non-user message: leaf = selected node
      newLeafId = targetId;
    }

    // Switch leaf (with or without summary)
    // Summary is attached at the navigation target position (newLeafId), not the old branch
    let summaryEntry: BranchSummaryEntry | undefined;
    if (summaryText) {
      // Create summary at target position (can be null for root)
      const summaryId = this.sessionManager.branchWithSummary(
        newLeafId,
        summaryText,
        summaryDetails,
        fromExtension,
      );
      summaryEntry = this.sessionManager.getEntry(
        summaryId,
      ) as BranchSummaryEntry;

      // Attach label to the summary entry
      if (label) {
        this.sessionManager.appendLabelChange(summaryId, label);
        this._emit({
          label,
          targetId: summaryId,
          type: "label_changed",
        });
      }
    } else if (newLeafId === null) {
      // No summary, navigating to root - reset leaf
      this.sessionManager.resetLeaf();
    } else {
      // No summary, navigating to non-root
      this.sessionManager.branch(newLeafId);
    }

    // Attach label to target entry when not summarizing (no summary entry to label)
    if (label && !summaryText) {
      this.sessionManager.appendLabelChange(targetId, label);
      this._emit({
        label,
        targetId,
        type: "label_changed",
      });
    }

    // Update agent state
    const sessionContext = this.sessionManager.buildSessionContext();
    this.agent.state.messages = sessionContext.messages;

    // Emit session_tree event
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        fromExtension: summaryText ? fromExtension : undefined,
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        type: "session_tree",
      });
    }

    // Emit tree_changed to UI listeners
    this._emit({
      fromExtension: summaryText ? fromExtension : undefined,
      newLeafId: this.sessionManager.getLeafId(),
      oldLeafId,
      summaryEntry,
      type: "tree_changed",
    });

    // Emit to custom tools

    this._branchSummaryAbortController = undefined;
    return { cancelled: false, editorText, summaryEntry };
  }

  /**
   * Send a prompt to the agent.
   * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;

    // Handle extension commands first (execute immediately, even during streaming)
    // Extension commands manage their own LLM interaction via pi.sendMessage()
    if (expandPromptTemplates && text.startsWith("/")) {
      const handled = await this._tryExecuteExtensionCommand(text);
      if (handled) {
        // Extension command executed, no prompt to send
        return;
      }
    }

    // Emit input event for extension interception (before skill/template expansion)
    let currentText = text;
    let currentImages = options?.images;
    if (this._extensionRunner?.hasHandlers("input")) {
      const inputResult = await this._extensionRunner.emitInput(
        currentText,
        currentImages,
        options?.source ?? "interactive",
      );
      if (inputResult.action === "handled") {
        return;
      }
      if (inputResult.action === "transform") {
        currentText = inputResult.text;
        currentImages = inputResult.images ?? currentImages;
      }
    }

    // Expand skill commands (/skill:name args) and prompt templates (/template args)
    let expandedText = currentText;
    if (expandPromptTemplates) {
      expandedText = this._expandSkillCommand(expandedText);
      expandedText = expandPromptTemplate(expandedText, [
        ...this.promptTemplates,
      ]);
    }

    // If streaming, queue via steer() or followUp() based on option
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      if (options.streamingBehavior === "followUp") {
        await this._queueFollowUp(expandedText, currentImages);
      } else {
        await this._queueSteer(expandedText, currentImages);
      }
      return;
    }

    // Validate model
    if (!this.model) {
      throw new Error(
        "No model selected.\n\n" +
          `Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}\n\n` +
          "Then use /model to select a model.",
      );
    }

    this._logger.debug("model_check", {
      id: this.model.id,
      provider: this.model.provider,
    });

    if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
      const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
      if (isOAuth) {
        throw new Error(
          `Authentication failed for "${this.model.provider}". ` +
            `Credentials may have expired or network is unavailable. ` +
            `Run '/login ${this.model.provider}' to re-authenticate.`,
        );
      }
      throw new Error(
        `No API key found for ${this.model.provider}.\n\n` +
          `Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`,
      );
    }
    this._logger.debug("auth_check_passed");

    // Check if we need to compact before sending (catches aborted responses)
    const lastAssistant = this._findLastAssistantMessage();
    if (lastAssistant) {
      await this._checkCompaction(lastAssistant, false);
    }

    // Build messages array (custom message if any, then user message)
    const messages: AgentMessage[] = [];

    // Add user message
    const userContent: (ImageContent | TextContent)[] = [
      { text: expandedText, type: "text" },
    ];
    if (currentImages) {
      userContent.push(...currentImages);
    }
    messages.push({
      content: userContent,
      role: "user",
      timestamp: Date.now(),
    });

    // Inject any pending "nextTurn" messages as context alongside the user message
    for (const msg of this._pendingNextTurnMessages) {
      messages.push(msg);
    }
    this._pendingNextTurnMessages = [];

    // Emit before_agent_start extension event
    if (this._extensionRunner) {
      const result = await this._extensionRunner.emitBeforeAgentStart(
        expandedText,
        currentImages,
        this._baseSystemPrompt,
      );
      // Add all custom messages from extensions
      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            content: msg.content,
            customType: msg.customType,
            details: msg.details,
            display: msg.display,
            role: "custom",
            timestamp: Date.now(),
          });
        }
      }
      // Apply extension-modified system prompt, or reset to base
      if (result?.systemPrompt) {
        this.agent.state.systemPrompt = result.systemPrompt;
      } else {
        // Ensure we're using the base prompt (in case previous turn had modifications)
        this.agent.state.systemPrompt = this._baseSystemPrompt;
      }
    }

    this._logger.debug("prompt_start", { messageCount: messages.length });
    const t0 = Date.now();
    try {
      await this.agent.prompt(messages);
    } catch (e: any) {
      this._logger.error("prompt_error", { message: e.message }, e);
      throw e;
    }
    console.log(`[AgentSession] prompt took ${Date.now() - t0}ms`);
    await this.waitForRetry();
  }

  async reload(): Promise<void> {
    const previousFlagValues = this._extensionRunner?.getFlagValues();
    await this._extensionRunner?.emit({ type: "session_shutdown" });
    await this.settingsManager.reload();
    resetApiProviders();
    await this._resourceLoader.reload();
    this._buildRuntime({
      flagValues: previousFlagValues,
      includeAllExtensionTools: true,
    });

    const hasBindings =
      this._extensionUIContext ||
      this._extensionCommandContextActions ||
      this._extensionShutdownHandler ||
      this._extensionErrorListener;
    if (this._extensionRunner && hasBindings) {
      await this._extensionRunner.emit({
        reason: "reload",
        type: "session_start",
      });
      await this.extendResourcesFromExtensions("reload");
    }

    this._emitResourcesChanged();
  }

  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queues message, processed when loop pulls from queue
   * - Not streaming + triggerTurn: appends to state/session, starts new turn
   * - Not streaming + no trigger: appends to state/session, no turn
   *
   * @param message Custom message with customType, content, display, details
   * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
   * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
   */
  async sendCustomMessage<T = unknown>(
    message: Pick<
      CustomMessage<T>,
      "content" | "customType" | "details" | "display"
    >,
    options?: {
      deliverAs?: "followUp" | "nextTurn" | "steer";
      triggerTurn?: boolean;
    },
  ): Promise<void> {
    const appMessage = {
      content: message.content,
      customType: message.customType,
      details: message.details,
      display: message.display,
      role: "custom" as const,
      timestamp: Date.now(),
    } satisfies CustomMessage<T>;
    if (options?.deliverAs === "nextTurn") {
      this._pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.agent.prompt(appMessage);
    } else {
      this.agent.state.messages.push(appMessage);
      this.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      this._emit({ id: nanoid(), message: appMessage, type: "message_start" });
      this._emit({ id: nanoid(), message: appMessage, type: "message_end" });
    }
  }

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   *
   * @param content User message content (string or content array)
   * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
   */
  async sendUserMessage(
    content: (ImageContent | TextContent)[] | string,
    options?: { deliverAs?: "followUp" | "steer" },
  ): Promise<void> {
    // Normalize content to text string + optional images
    let text: string;
    let images: ImageContent[] | undefined;

    if (typeof content === "string") {
      text = content;
    } else {
      const textParts: string[] = [];
      images = [];
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join("\n");
      if (images.length === 0) images = undefined;
    }

    // Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
    await this.prompt(text, {
      expandPromptTemplates: false,
      images,
      source: "extension",
      streamingBehavior: options?.deliverAs,
    });
  }

  /**
   * Set active tools by name.
   * Only tools in the registry can be enabled. Unknown tool names are ignored.
   * Also rebuilds the system prompt to reflect the new tool set.
   * Changes take effect on the next agent turn.
   */
  setActiveToolsByName(toolNames: string[]): void {
    const tools: AgentTool[] = [];
    const validToolNames: string[] = [];
    for (const name of toolNames) {
      const tool = this._toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
        validToolNames.push(name);
      }
    }

    // Check if tool set actually changed
    const currentToolNames = this.agent.state.tools.map((t) => t.name).sort();
    const newToolNames = validToolNames.sort();
    const hasChanged =
      currentToolNames.length !== newToolNames.length ||
      !currentToolNames.every((name, i) => name === newToolNames[i]);

    this.agent.state.tools = tools;

    // Rebuild base system prompt with new tool set
    this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
    this.agent.state.systemPrompt = this._baseSystemPrompt;

    if (hasChanged) {
      this._emit({
        activeToolNames: validToolNames,
        type: "tools_changed",
      });
    }
  }

  /**
   * Toggle auto-compaction setting.
   */
  setAutoCompactionEnabled(enabled: boolean): void {
    this.settingsManager.setCompactionEnabled(enabled);
  }

  /**
   * Toggle auto-retry setting.
   */
  setAutoRetryEnabled(enabled: boolean): void {
    this.settingsManager.setRetryEnabled(enabled);
  }

  /**
   * Set follow-up message mode.
   * Saves to settings.
   */
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.agent.followUpMode = mode;
    this.settingsManager.setFollowUpMode(mode);
  }

  /**
   * Set model directly.
   * Validates that auth is configured, saves to session and settings.
   * @throws Error if no auth is configured for the model
   */
  async setModel(model: Model<any>): Promise<void> {
    if (!this._modelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const previousModel = this.model;
    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    this.agent.state.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

    // Re-clamp thinking level for new model's capabilities
    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(model, previousModel, "set");
  }

  // =========================================================================
  // Model Management
  // =========================================================================

  /** Update scoped models for cycling */
  setScopedModels(
    scopedModels: { model: Model<any>; thinkingLevel?: ThinkingLevel }[],
  ): void {
    this._scopedModels = scopedModels;
  }

  /**
   * Set a display name for the current session.
   */
  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
    this._emit({
      sessionName: name,
      type: "session_metadata_changed",
    });
  }

  /**
   * Set steering message mode.
   * Saves to settings.
   */
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.agent.steeringMode = mode;
    this.settingsManager.setSteeringMode(mode);
  }

  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level)
      ? level
      : this._clampThinkingLevel(level, availableLevels);

    // Only persist if actually changing
    const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;

    this.agent.state.thinkingLevel = effectiveLevel;

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
      this._emit({
        availableLevels,
        level: effectiveLevel,
        type: "thinking_level_changed",
      });
    }
  }

  /**
   * Queue a steering message while the agent is running.
   * Delivered after the current assistant turn finishes executing its tool calls,
   * before the next LLM call.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async steer(text: string, images?: ImageContent[]): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this._throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this._expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [
      ...this.promptTemplates,
    ]);

    await this._queueSteer(expandedText, images);
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Subscribe to agent events.
   * Session persistence is handled internally (saves messages on message_end).
   * Multiple listeners can be added. Returns unsubscribe function for this listener.
   */
  subscribe(listener: AgentSessionEventListener): () => void {
    this._eventListeners.push(listener);

    // Return unsubscribe function for this specific listener
    return () => {
      const index = this._eventListeners.indexOf(listener);
      if (index !== -1) {
        this._eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Check if current model supports thinking/reasoning.
   */
  supportsThinking(): boolean {
    return !!this.model?.reasoning;
  }

  /**
   * Check if current model supports xhigh thinking level.
   */
  supportsXhighThinking(): boolean {
    return this.model
      ? getSupportedThinkingLevels(this.model).includes("xhigh")
      : false;
  }

  private _applyExtensionBindings(runner: ExtensionRunner): void {
    runner.setUIContext(this._extensionUIContext);
    runner.bindCommandContext(this._extensionCommandContextActions);

    this._extensionErrorUnsubscriber?.();
    this._extensionErrorUnsubscriber = this._extensionErrorListener
      ? runner.onError(this._extensionErrorListener)
      : undefined;
  }

  private _bindExtensionCore(runner: ExtensionRunner): void {
    const getCommands = (): SlashCommandInfo[] => {
      const extensionCommands: SlashCommandInfo[] = runner
        .getRegisteredCommands()
        .map((command) => ({
          description: command.description,
          name: command.invocationName,
          source: "extension",
          sourceInfo: command.sourceInfo,
        }));

      const templates: SlashCommandInfo[] = this.promptTemplates.map(
        (template) => ({
          description: template.description,
          name: template.name,
          source: "prompt",
          sourceInfo: template.sourceInfo,
        }),
      );

      const skills: SlashCommandInfo[] = this._resourceLoader
        .getSkills()
        .skills.map((skill) => ({
          description: skill.description,
          name: `skill:${skill.name}`,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        }));

      return [...extensionCommands, ...templates, ...skills];
    };

    runner.bindCore(
      {
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        getCommands,
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        getThinkingLevel: () => this.thinkingLevel,
        refreshTools: () => this._refreshToolRegistry(),
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err) => {
            runner.emitError({
              error: err instanceof Error ? err.message : String(err),
              event: "send_message",
              extensionPath: "<runtime>",
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err) => {
            runner.emitError({
              error: err instanceof Error ? err.message : String(err),
              event: "send_user_message",
              extensionPath: "<runtime>",
            });
          });
        },
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
          this._emit({
            label,
            targetId: entryId,
            type: "label_changed",
          });
        },
        setModel: async (model) => {
          if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
          await this.setModel(model);
          return true;
        },
        setSessionName: (name) => {
          this.sessionManager.appendSessionInfo(name);
        },
        setThinkingLevel: (level) => this.setThinkingLevel(level),
      },
      {
        abort: () => this.abort(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err =
                error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getContextUsage: () => this.getContextUsage(),
        getModel: () => this.model,
        getSignal: () => this.agent.signal,
        getSystemPrompt: () => this.systemPrompt,
        hasPendingMessages: () => this.pendingMessageCount > 0,
        isIdle: () => !this.isStreaming,
        shutdown: () => {
          this._extensionShutdownHandler?.();
        },
      },
      {
        registerProvider: (name, config) => {
          this._modelRegistry.registerProvider(name, config);
          this._refreshCurrentModelFromRegistry();
        },
        unregisterProvider: (name) => {
          this._modelRegistry.unregisterProvider(name);
          this._refreshCurrentModelFromRegistry();
        },
      },
    );
  }

  private _buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
    includeAllExtensionTools?: boolean;
  }): void {
    this._logger.info("build_runtime_start", {
      toolsCount: this._tools.length,
    });

    const extensionsResult = this._resourceLoader.getExtensions();
    this._logger.debug("build_runtime_extensions", {
      extensionsCount: extensionsResult.extensions.length,
    });

    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    const hasExtensions = extensionsResult.extensions.length > 0;
    const hasTools = this._tools.length > 0;
    this._logger.debug("build_runtime_has_extensions_tools", {
      hasExtensions,
      hasTools,
    });

    this._extensionRunner =
      hasExtensions || hasTools
        ? new ExtensionRunner(
            extensionsResult.extensions,
            extensionsResult.runtime,
            this._cwd,
            this.sessionManager,
            this._modelRegistry,
          )
        : undefined;
    this._logger.debug("build_runtime_extension_runner", {
      created: !!this._extensionRunner,
    });

    if (this._extensionRunnerRef) {
      this._extensionRunnerRef.current = this._extensionRunner;
      this._logger.debug("build_runtime_extension_runner_ref_set");
    }
    if (this._extensionRunner) {
      this._bindExtensionCore(this._extensionRunner);
      this._applyExtensionBindings(this._extensionRunner);
    }

    this._refreshToolRegistry();
    const toolNames = options.activeToolNames ?? [...this._toolRegistry.keys()];
    this.setActiveToolsByName(toolNames);
    this._logger.info("build_runtime_complete");
  }

  /**
   * Check if compaction is needed and run it.
   * Called after agent_end and before prompt submission.
   *
   * Two cases:
   * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
   * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
   *
   * @param assistantMessage The assistant message to check
   * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
   */
  private async _checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
  ): Promise<void> {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) return;

    // Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return;

    const contextWindow = this.model?.contextWindow ?? 0;

    // Skip overflow check if the message came from a different model.
    // This handles the case where user switched from a smaller-context model (e.g. opus)
    // to a larger-context model (e.g. codex) - the overflow error from the old model
    // shouldn't trigger compaction for the new model.
    const sameModel =
      this.model &&
      assistantMessage.provider === this.model.provider &&
      assistantMessage.model === this.model.id;

    // Skip compaction checks if this assistant message is older than the latest
    // compaction boundary. This prevents a stale pre-compaction usage/error
    // from retriggering compaction on the first prompt after compaction.
    const compactionEntry = getLatestCompactionEntry(
      this.sessionManager.getBranch(),
    );
    const assistantIsFromBeforeCompaction =
      compactionEntry !== null &&
      assistantMessage.timestamp <=
        new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) {
      return;
    }

    // Case 1: Overflow - LLM returned context overflow error
    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this._overflowRecoveryAttempted) {
        this._emit({
          aborted: false,
          errorMessage:
            "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
          reason: "overflow",
          result: undefined,
          type: "compaction_end",
          willRetry: false,
        });
        return;
      }

      this._overflowRecoveryAttempted = true;
      // Remove the error message from agent state (it IS saved to session for history,
      // but we don't want it in context for the retry)
      const messages = this.agent.state.messages;
      if (
        messages.length > 0 &&
        messages[messages.length - 1].role === "assistant"
      ) {
        this.agent.state.messages = messages.slice(0, -1);
      }
      await this._runAutoCompaction("overflow", true);
      return;
    }

    // Case 2: Threshold - context is getting large
    // For error messages (no usage data), estimate from last successful response.
    // This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
    let contextTokens: number;
    if (assistantMessage.stopReason === "error") {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) return; // No usage data at all
      // Verify the usage source is post-compaction. Kept pre-compaction messages
      // have stale usage reflecting the old (larger) context and would falsely
      // trigger compaction right after one just finished.
      const usageMsg = messages[estimate.lastUsageIndex];
      if (
        compactionEntry &&
        usageMsg.role === "assistant" &&
        (usageMsg as AssistantMessage).timestamp <=
          new Date(compactionEntry.timestamp).getTime()
      ) {
        return;
      }
      contextTokens = estimate.tokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      await this._runAutoCompaction("threshold", false);
    }
  }

  // =========================================================================
  // Queue Mode Management
  // =========================================================================

  private _clampThinkingLevel(
    level: ThinkingLevel,
    availableLevels: ThinkingLevel[],
  ): ThinkingLevel {
    const ordered = THINKING_LEVELS_WITH_XHIGH;
    const available = new Set(availableLevels);
    const requestedIndex = ordered.indexOf(level);
    if (requestedIndex === -1) {
      return availableLevels[0] ?? "off";
    }
    for (let i = requestedIndex; i < ordered.length; i++) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    for (let i = requestedIndex - 1; i >= 0; i--) {
      const candidate = ordered[i];
      if (available.has(candidate)) return candidate;
    }
    return availableLevels[0] ?? "off";
  }

  private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
    if (event.type !== "agent_end" || this._retryPromise) {
      return;
    }

    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return;
    }

    const lastAssistant = this._findLastAssistantInMessages(event.messages);
    if (!lastAssistant || !this._isRetryableError(lastAssistant)) {
      return;
    }

    this._retryPromise = new Promise((resolve) => {
      this._retryResolve = resolve;
    });
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  private async _cycleAvailableModel(
    direction: "backward" | "forward",
  ): Promise<ModelCycleResult | undefined> {
    const availableModels = await this._modelRegistry.getAvailable();
    if (availableModels.length <= 1) return undefined;

    const currentModel = this.model;
    let currentIndex = availableModels.findIndex((m) =>
      modelsAreEqual(m, currentModel),
    );

    if (currentIndex === -1) currentIndex = 0;
    const len = availableModels.length;
    const nextIndex =
      direction === "forward"
        ? (currentIndex + 1) % len
        : (currentIndex - 1 + len) % len;
    const nextModel = availableModels[nextIndex];

    const thinkingLevel = this._getThinkingLevelForModelSwitch();
    this.agent.state.model = nextModel;
    this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
    this.settingsManager.setDefaultModelAndProvider(
      nextModel.provider,
      nextModel.id,
    );

    // Re-clamp thinking level for new model's capabilities
    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(nextModel, currentModel, "cycle");

    return {
      isScoped: false,
      model: nextModel,
      thinkingLevel: this.thinkingLevel,
    };
  }

  private async _cycleScopedModel(
    direction: "backward" | "forward",
  ): Promise<ModelCycleResult | undefined> {
    const scopedModels = this._scopedModels.filter((scoped) =>
      this._modelRegistry.hasConfiguredAuth(scoped.model),
    );
    if (scopedModels.length <= 1) return undefined;

    const currentModel = this.model;
    let currentIndex = scopedModels.findIndex((sm) =>
      modelsAreEqual(sm.model, currentModel),
    );

    if (currentIndex === -1) currentIndex = 0;
    const len = scopedModels.length;
    const nextIndex =
      direction === "forward"
        ? (currentIndex + 1) % len
        : (currentIndex - 1 + len) % len;
    const next = scopedModels[nextIndex];
    const thinkingLevel = this._getThinkingLevelForModelSwitch(
      next.thinkingLevel,
    );

    // Apply model
    this.agent.state.model = next.model;
    this.sessionManager.appendModelChange(next.model.provider, next.model.id);
    this.settingsManager.setDefaultModelAndProvider(
      next.model.provider,
      next.model.id,
    );

    // Apply thinking level.
    // - Explicit scoped model thinking level overrides current session level
    // - Undefined scoped model thinking level inherits the current session preference
    // setThinkingLevel clamps to model capabilities.
    this.setThinkingLevel(thinkingLevel);

    await this._emitModelSelect(next.model, currentModel, "cycle");

    return {
      isScoped: true,
      model: next.model,
      thinkingLevel: this.thinkingLevel,
    };
  }

  /**
   * Temporarily disconnect from agent events.
   * User listeners are preserved and will receive events again after resubscribe().
   * Used internally during operations that need to pause event processing.
   */
  private _disconnectFromAgent(): void {
    if (this._unsubscribeAgent) {
      this._unsubscribeAgent();
      this._unsubscribeAgent = undefined;
    }
  }

  /** Emit an event to all listeners */
  private _emit(event: AgentSessionEvent): void {
    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end"
    ) {
      if (event.type === "message_update") {
        const enrichedEvent: AgentSessionEvent = {
          delta: event.delta,
          id: event.id,
          message: event.message,
          thinkingDelta: event.thinkingDelta,
          type: "message_update",
        };
        for (const l of this._eventListeners) {
          l(enrichedEvent);
        }
      } else {
        const enrichedEvent =
          event.type === "message_start"
            ? {
                id: event.id,
                message: event.message,
                type: "message_start" as const,
              }
            : {
                id: event.id,
                message: event.message,
                type: "message_end" as const,
              };
        for (const l of this._eventListeners) {
          l(enrichedEvent);
        }
      }
    } else {
      for (const l of this._eventListeners) {
        l(event);
      }
    }
  }

  private async _emitModelSelect(
    nextModel: Model<any>,
    previousModel: Model<any> | undefined,
    source: "cycle" | "restore" | "set",
  ): Promise<void> {
    if (modelsAreEqual(previousModel, nextModel)) return;

    // Emit to UI listeners
    this._emit({
      model: nextModel,
      previousModel,
      source,
      type: "model_changed",
    });

    // Emit to extensions
    if (this._extensionRunner) {
      await this._extensionRunner.emit({
        model: nextModel,
        previousModel,
        source,
        type: "model_select",
      });
    }
  }

  private _emitQueueUpdate(): void {
    this._emit({
      followUp: [...this._followUpMessages],
      steering: [...this._steeringMessages],
      type: "queue_update",
    });
  }

  private _emitResourcesChanged(): void {
    const extensionsResult = this._resourceLoader.getExtensions();
    const skillsResult = this._resourceLoader.getSkills();
    const promptsResult = this._resourceLoader.getPrompts();
    const themesResult = this._resourceLoader.getThemes();

    this._emit({
      extensionErrors: extensionsResult.errors,
      extensions: extensionsResult.extensions.map((e) => ({
        path: e.path,
        sourceInfo: e.sourceInfo,
      })),
      promptDiagnostics: promptsResult.diagnostics,
      prompts: promptsResult.prompts.map((p) => ({
        filePath: p.filePath,
        name: p.name,
        sourceInfo: p.sourceInfo,
      })),
      skillDiagnostics: skillsResult.diagnostics,
      skills: skillsResult.skills.map((s) => ({
        filePath: s.filePath,
        name: s.name,
        sourceInfo: s.sourceInfo,
      })),
      themeDiagnostics: themesResult.diagnostics,
      themes: themesResult.themes
        .filter((t) => t.name !== undefined)
        .map((t) => ({
          name: t.name as string,
          sourceInfo: t.sourceInfo,
          sourcePath: t.sourcePath,
        })),
      type: "resources_changed",
    });
  }

  /**
   * Expand skill commands (/skill:name args) to their full content.
   * Returns the expanded text, or the original text if not a skill command or skill not found.
   * Emits errors via extension runner if file read fails.
   */
  private _expandSkillCommand(text: string): string {
    if (!text.startsWith("/skill:")) return text;

    const spaceIndex = text.indexOf(" ");
    const skillName =
      spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

    const skill = this.resourceLoader
      .getSkills()
      .skills.find((s) => s.name === skillName);
    if (!skill) return text; // Unknown skill, pass through

    try {
      const content = readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch (err) {
      // Emit error like extension commands do
      this._extensionRunner?.emitError({
        error: err instanceof Error ? err.message : String(err),
        event: "skill_expansion",
        extensionPath: skill.filePath,
      });
      return text; // Return original on error
    }
  }

  private _extractUserMessageText(
    content: { text?: string; type: string }[] | string,
  ): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { text: string; type: "text" } => c.type === "text")
        .map((c) => c.text)
        .join("");
    }
    return "";
  }

  private _findLastAssistantInMessages(
    messages: AgentMessage[],
  ): AssistantMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        return message as AssistantMessage;
      }
    }
    return undefined;
  }

  /** Find the last assistant message in agent state (including aborted ones) */
  private _findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        return msg as AssistantMessage;
      }
    }
    return undefined;
  }

  private async _getRequiredRequestAuth(model: Model<any>): Promise<{
    apiKey: string;
    headers?: Record<string, string>;
  }> {
    const result = await this._modelRegistry.getApiKeyAndHeaders(model);
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (result.apiKey) {
      return { apiKey: result.apiKey, headers: result.headers };
    }

    const isOAuth = this._modelRegistry.isUsingOAuth(model);
    if (isOAuth) {
      throw new Error(
        `Authentication failed for "${model.provider}". ` +
          `Credentials may have expired or network is unavailable. ` +
          `Run '/login ${model.provider}' to re-authenticate.`,
      );
    }
    throw new Error(
      `No API key found for ${model.provider}.\n\n` +
        `Use /login or set an API key environment variable. See ${join(getDocsPath(), "providers.md")}`,
    );
  }

  private _getThinkingLevelForModelSwitch(
    explicitLevel?: ThinkingLevel,
  ): ThinkingLevel {
    if (explicitLevel !== undefined) {
      return explicitLevel;
    }
    if (!this.supportsThinking()) {
      return (
        this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL
      );
    }
    return this.thinkingLevel;
  }

  /** Extract text content from a message */
  private _getUserMessageText(message: Message): string {
    if (message.role !== "user") return "";
    const content = message.content;
    if (typeof content === "string") return content;
    const textBlocks = content.filter((c) => c.type === "text");
    return textBlocks.map((c) => (c as TextContent).text).join("");
  }

  /** Internal handler for agent events - shared by subscribe and reconnect */
  private _handleAgentEvent = (event: AgentEvent): void => {
    // Create retry promise synchronously before queueing async processing.
    // Agent.emit() calls this handler synchronously, and prompt() calls waitForRetry()
    // as soon as agent.prompt() resolves. If _retryPromise is created only inside
    // _processAgentEvent, slow earlier queued events can delay agent_end processing
    // and waitForRetry() can miss the in-flight retry.
    this._createRetryPromiseForAgentEnd(event);

    this._agentEventQueue = this._agentEventQueue.then(
      () => this._processAgentEvent(event),
      () => this._processAgentEvent(event),
    );

    // Keep queue alive if an event handler fails
    this._agentEventQueue.catch(() => {});
  };

  /**
   * Handle retryable errors with exponential backoff.
   * @returns true if retry was initiated, false if max retries exceeded or disabled
   */
  private async _handleRetryableError(
    message: AssistantMessage,
  ): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      this._resolveRetry();
      return false;
    }

    // Retry promise is created synchronously in _handleAgentEvent for agent_end.
    // Keep a defensive fallback here in case a future refactor bypasses that path.
    if (!this._retryPromise) {
      this._retryPromise = new Promise((resolve) => {
        this._retryResolve = resolve;
      });
    }

    this._retryAttempt++;

    if (this._retryAttempt > settings.maxRetries) {
      // Max retries exceeded, emit final failure and reset
      this._emit({
        attempt: this._retryAttempt - 1,
        finalError: message.errorMessage,
        success: false,
        type: "auto_retry_end",
      });
      this._retryAttempt = 0;
      this._resolveRetry(); // Resolve so waitForRetry() completes
      return false;
    }

    const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

    this._emit({
      attempt: this._retryAttempt,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
      maxAttempts: settings.maxRetries,
      type: "auto_retry_start",
    });

    // Remove error message from agent state (keep in session for history)
    const messages = this.agent.state.messages;
    if (
      messages.length > 0 &&
      messages[messages.length - 1].role === "assistant"
    ) {
      this.agent.state.messages = messages.slice(0, -1);
    }

    // Wait with exponential backoff (abortable)
    this._retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this._retryAbortController.signal);
    } catch {
      // Aborted during sleep - emit end event so UI can clean up
      const attempt = this._retryAttempt;
      this._retryAttempt = 0;
      this._retryAbortController = undefined;
      this._emit({
        attempt,
        finalError: "Retry cancelled",
        success: false,
        type: "auto_retry_end",
      });
      this._resolveRetry();
      return false;
    }
    this._retryAbortController = undefined;

    // Retry via continue() - use setTimeout to break out of event handler chain
    setTimeout(() => {
      this.agent.continue().catch(() => {
        // Retry failed - will be caught by next agent_end
      });
    }, 0);

    return true;
  }

  /**
   * Install tool hooks once on the Agent instance.
   *
   * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
   * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
   * registered tool execution to the extension context. Tool call and tool result interception now
   * happens here instead of in wrappers.
   */
  private _installAgentToolHooks(): void {
    this.agent.beforeToolCall = async ({ args, toolCall }) => {
      const runner = this._extensionRunner;
      if (!runner?.hasHandlers("tool_call")) {
        return undefined;
      }

      await this._agentEventQueue;

      try {
        return await runner.emitToolCall({
          input: args as Record<string, unknown>,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          type: "tool_call",
        });
      } catch (err) {
        if (err instanceof Error) {
          throw err;
        }
        throw new Error(`Extension failed, blocking execution: ${String(err)}`);
      }
    };

    this.agent.afterToolCall = async ({ args, isError, result, toolCall }) => {
      const runner = this._extensionRunner;
      if (!runner?.hasHandlers("tool_result")) {
        return undefined;
      }

      const hookResult = await runner.emitToolResult({
        content: result.content,
        details: isError ? undefined : result.details,
        input: args as Record<string, unknown>,
        isError,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        type: "tool_result",
      });

      if (!hookResult || isError) {
        return undefined;
      }

      return {
        content: hookResult.content,
        details: hookResult.details,
      };
    };
  }

  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  private _isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) return false;

    // Context overflow is handled by compaction, not retry
    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) return false;

    const err = message.errorMessage;
    // Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors, fetch failed, request ended without sending chunks, terminated, retry delay exceeded
    return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed? out|timeout|terminated|retry delay/i.test(
      err,
    );
  }

  // =========================================================================
  // Auto-Retry
  // =========================================================================

  private _normalizePromptGuidelines(
    guidelines: string[] | undefined,
  ): string[] {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }

    const unique = new Set<string>();
    for (const guideline of guidelines) {
      const normalized = guideline.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  private _normalizePromptSnippet(
    text: string | undefined,
  ): string | undefined {
    if (!text) return undefined;
    const oneLine = text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return oneLine.length > 0 ? oneLine : undefined;
  }

  private async _processAgentEvent(event: AgentEvent): Promise<void> {
    // When a user message starts, check if it's from either queue and remove it BEFORE emitting
    // This ensures the UI sees the updated queue state
    if (event.type === "message_start" && event.message.role === "user") {
      this._overflowRecoveryAttempted = false;
      const messageText = this._getUserMessageText(event.message);
      if (messageText) {
        // Check steering queue first
        const steeringIndex = this._steeringMessages.indexOf(messageText);
        if (steeringIndex !== -1) {
          this._steeringMessages.splice(steeringIndex, 1);
          this._emitQueueUpdate();
        } else {
          // Check follow-up queue
          const followUpIndex = this._followUpMessages.indexOf(messageText);
          if (followUpIndex !== -1) {
            this._followUpMessages.splice(followUpIndex, 1);
            this._emitQueueUpdate();
          }
        }
      }
    }

    // Track current message ID for snapshot alignment
    if (event.type === "message_start" && event.message.role === "assistant") {
      this._currentMessageId = event.id;
    }
    if (event.type === "message_end") {
      this._currentMessageId = undefined;
    }

    // Notify all listeners
    this._emit(event);

    // Handle session persistence
    if (event.type === "message_end") {
      // Check if this is a custom message from extensions
      if (event.message.role === "custom") {
        // Persist as CustomMessageEntry
        this.sessionManager.appendCustomMessageEntry(
          event.message.customType,
          event.message.content,
          event.message.display,
          event.message.details,
        );
      } else if (
        event.message.role === "user" ||
        event.message.role === "assistant" ||
        event.message.role === "toolResult"
      ) {
        // Regular LLM message - persist as SessionMessageEntry
        // Use the agent event ID so snapshot timeline entries match live event IDs.
        this.sessionManager.appendMessage(event.message, event.id);
      }
      // Other message types (compactionSummary, branchSummary) are persisted elsewhere

      // Track assistant message for auto-compaction (checked on agent_end)
      if (event.message.role === "assistant") {
        this._lastAssistantMessage = event.message;

        const assistantMsg = event.message as AssistantMessage;
        if (assistantMsg.stopReason !== "error") {
          this._overflowRecoveryAttempted = false;
        }

        // Reset retry counter immediately on successful assistant response
        // This prevents accumulation across multiple LLM calls within a turn
        if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
          this._emit({
            attempt: this._retryAttempt,
            success: true,
            type: "auto_retry_end",
          });
          this._retryAttempt = 0;
        }

        // Emit context_usage_changed when usage becomes known from assistant response
        if (assistantMsg.usage) {
          this._emit({
            cost: this.getSessionStats().cost,
            type: "context_usage_changed",
            usage: this.getContextUsage(),
          });
        }
      }
    }

    // Check auto-retry and auto-compaction after agent completes
    if (event.type === "agent_end" && this._lastAssistantMessage) {
      const msg = this._lastAssistantMessage;
      this._lastAssistantMessage = undefined;

      // Check for retryable errors first (overloaded, rate limit, server errors)
      if (this._isRetryableError(msg)) {
        const didRetry = await this._handleRetryableError(msg);
        if (didRetry) return; // Retry was initiated, don't proceed to compaction
      }

      this._resolveRetry();
      await this._checkCompaction(msg);
    }
  }

  /**
   * Internal: Queue a follow-up message (already expanded, no extension command check).
   */
  private async _queueFollowUp(
    text: string,
    images?: ImageContent[],
  ): Promise<void> {
    this._followUpMessages.push(text);
    this._emitQueueUpdate();
    const content: (ImageContent | TextContent)[] = [{ text, type: "text" }];
    if (images) {
      content.push(...images);
    }
    this.agent.followUp({
      content,
      role: "user",
      timestamp: Date.now(),
    });
  }

  /**
   * Internal: Queue a steering message (already expanded, no extension command check).
   */
  private async _queueSteer(
    text: string,
    images?: ImageContent[],
  ): Promise<void> {
    this._steeringMessages.push(text);
    this._emitQueueUpdate();
    const content: (ImageContent | TextContent)[] = [{ text, type: "text" }];
    if (images) {
      content.push(...images);
    }
    this.agent.steer({
      content,
      role: "user",
      timestamp: Date.now(),
    });
  }

  private _rebuildSystemPrompt(toolNames: string[]): string {
    const validToolNames = toolNames.filter((name) =>
      this._toolRegistry.has(name),
    );
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const name of validToolNames) {
      const snippet = this._toolPromptSnippets.get(name);
      if (snippet) {
        toolSnippets[name] = snippet;
      }

      const toolGuidelines = this._toolPromptGuidelines.get(name);
      if (toolGuidelines) {
        promptGuidelines.push(...toolGuidelines);
      }
    }

    const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
    const loaderAppendSystemPrompt =
      this._resourceLoader.getAppendSystemPrompt();
    const appendSystemPrompt =
      loaderAppendSystemPrompt.length > 0
        ? loaderAppendSystemPrompt.join("\n\n")
        : undefined;
    const loadedSkills = this._resourceLoader.getSkills().skills;
    const loadedContextFiles =
      this._resourceLoader.getAgentsFiles().agentsFiles;

    return buildSystemPrompt({
      appendSystemPrompt,
      contextFiles: loadedContextFiles,
      customPrompt: loaderSystemPrompt,
      cwd: this._cwd,
      promptGuidelines,
      selectedTools: validToolNames,
      skills: loadedSkills,
      toolSnippets,
    });
  }

  /**
   * Reconnect to agent events after _disconnectFromAgent().
   * Preserves all existing listeners.
   */
  private _reconnectToAgent(): void {
    if (this._unsubscribeAgent) return; // Already connected
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  private _refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this._modelRegistry.find(
      currentModel.provider,
      currentModel.id,
    );
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.state.model = refreshedModel;
  }

  // =========================================================================
  // Tree Navigation
  // =========================================================================

  private _refreshToolRegistry(): void {
    const registeredTools =
      this._extensionRunner?.getAllRegisteredTools() ?? [];
    const allTools = [
      ...registeredTools,
      ...this._tools.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
          source: "sdk",
        }),
      })),
    ];
    const definitionRegistry = new Map<string, ToolDefinitionEntry>();
    for (const tool of allTools) {
      definitionRegistry.set(tool.definition.name, {
        definition: tool.definition,
        sourceInfo: tool.sourceInfo,
      });
    }
    this._toolDefinitions = definitionRegistry;
    this._toolPromptSnippets = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const snippet = this._normalizePromptSnippet(
            definition.promptSnippet,
          );
          return snippet ? ([definition.name, snippet] as const) : undefined;
        })
        .filter(
          (entry): entry is readonly [string, string] => entry !== undefined,
        ),
    );
    this._toolPromptGuidelines = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const guidelines = this._normalizePromptGuidelines(
            definition.promptGuidelines,
          );
          return guidelines.length > 0
            ? ([definition.name, guidelines] as const)
            : undefined;
        })
        .filter(
          (entry): entry is readonly [string, string[]] => entry !== undefined,
        ),
    );
    const wrappedExtensionTools = this._extensionRunner
      ? wrapRegisteredTools(allTools, this._extensionRunner)
      : [];

    const toolRegistry = new Map<string, AgentTool>();
    for (const tool of wrappedExtensionTools as AgentTool[]) {
      toolRegistry.set(tool.name, tool);
    }
    this._toolRegistry = toolRegistry;
  }

  /** Resolve the pending retry promise */
  private _resolveRetry(): void {
    if (this._retryResolve) {
      this._retryResolve();
      this._retryResolve = undefined;
      this._retryPromise = undefined;
    }
  }

  /**
   * Internal: Run auto-compaction with events.
   */
  private async _runAutoCompaction(
    reason: "overflow" | "threshold",
    willRetry: boolean,
  ): Promise<void> {
    const settings = this.settingsManager.getCompactionSettings();

    this._emit({ reason, type: "compaction_start" });
    this._autoCompactionAbortController = new AbortController();

    try {
      if (!this.model) {
        this._emit({
          aborted: false,
          reason,
          result: undefined,
          type: "compaction_end",
          willRetry: false,
        });
        return;
      }

      const authResult = await this._modelRegistry.getApiKeyAndHeaders(
        this.model,
      );
      if (!authResult.ok || !authResult.apiKey) {
        this._emit({
          aborted: false,
          reason,
          result: undefined,
          type: "compaction_end",
          willRetry: false,
        });
        return;
      }
      const { apiKey, headers } = authResult;

      const pathEntries = this.sessionManager.getBranch();

      const preparation = prepareCompaction(pathEntries, settings);
      if (!preparation) {
        this._emit({
          aborted: false,
          reason,
          result: undefined,
          type: "compaction_end",
          willRetry: false,
        });
        return;
      }

      let extensionCompaction: CompactionResult | undefined;
      let fromExtension = false;

      if (this._extensionRunner?.hasHandlers("session_before_compact")) {
        const extensionResult = (await this._extensionRunner.emit({
          branchEntries: pathEntries,
          customInstructions: undefined,
          preparation,
          signal: this._autoCompactionAbortController.signal,
          type: "session_before_compact",
        })) as SessionBeforeCompactResult | undefined;

        if (extensionResult?.cancel) {
          this._emit({
            aborted: true,
            reason,
            result: undefined,
            type: "compaction_end",
            willRetry: false,
          });
          return;
        }

        if (extensionResult?.compaction) {
          extensionCompaction = extensionResult.compaction;
          fromExtension = true;
        }
      }

      let summary: string;
      let firstKeptEntryId: string;
      let tokensBefore: number;
      let details: unknown;

      if (extensionCompaction) {
        // Extension provided compaction content
        summary = extensionCompaction.summary;
        firstKeptEntryId = extensionCompaction.firstKeptEntryId;
        tokensBefore = extensionCompaction.tokensBefore;
        details = extensionCompaction.details;
      } else {
        // Generate compaction result
        const compactResult = await compact(
          preparation,
          this.model,
          apiKey,
          headers,
          undefined,
          this._autoCompactionAbortController.signal,
        );
        summary = compactResult.summary;
        firstKeptEntryId = compactResult.firstKeptEntryId;
        tokensBefore = compactResult.tokensBefore;
        details = compactResult.details;
      }

      if (this._autoCompactionAbortController.signal.aborted) {
        this._emit({
          aborted: true,
          reason,
          result: undefined,
          type: "compaction_end",
          willRetry: false,
        });
        return;
      }

      this.sessionManager.appendCompaction(
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromExtension,
      );
      const newEntries = this.sessionManager.getEntries();
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.state.messages = sessionContext.messages;

      // Get the saved compaction entry for the extension event
      const savedCompactionEntry = newEntries.find(
        (e) => e.type === "compaction" && e.summary === summary,
      ) as CompactionEntry | undefined;

      if (this._extensionRunner && savedCompactionEntry) {
        await this._extensionRunner.emit({
          compactionEntry: savedCompactionEntry,
          fromExtension,
          type: "session_compact",
        });
      }

      const result: CompactionResult = {
        details,
        firstKeptEntryId,
        summary,
        tokensBefore,
      };
      this._emit({
        aborted: false,
        reason,
        result,
        type: "compaction_end",
        willRetry,
      });

      // Emit context_usage_changed after compaction since context changed
      this._emit({
        cost: this.getSessionStats().cost,
        type: "context_usage_changed",
        usage: this.getContextUsage(),
      });

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (
          lastMsg?.role === "assistant" &&
          (lastMsg as AssistantMessage).stopReason === "error"
        ) {
          this.agent.state.messages = messages.slice(0, -1);
        }

        setTimeout(() => {
          this.agent.continue().catch(() => {});
        }, 100);
      } else if (this.agent.hasQueuedMessages()) {
        // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
        // Kick the loop so queued messages are actually delivered.
        setTimeout(() => {
          this.agent.continue().catch(() => {});
        }, 100);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "compaction failed";
      this._emit({
        aborted: false,
        errorMessage:
          reason === "overflow"
            ? `Context overflow recovery failed: ${errorMessage}`
            : `Auto-compaction failed: ${errorMessage}`,
        reason,
        result: undefined,
        type: "compaction_end",
        willRetry: false,
      });
    } finally {
      this._autoCompactionAbortController = undefined;
    }
  }

  /**
   * Throw an error if the text is an extension command.
   */
  private _throwIfExtensionCommand(text: string): void {
    if (!this._extensionRunner) return;

    const spaceIndex = text.indexOf(" ");
    const commandName =
      spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this._extensionRunner.getCommand(commandName);

    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
      );
    }
  }

  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
    if (!this._extensionRunner) return false;

    // Parse command name and args
    const spaceIndex = text.indexOf(" ");
    const commandName =
      spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

    const command = this._extensionRunner.getCommand(commandName);
    if (!command) return false;

    // Get command context from extension runner (includes session control methods)
    const ctx = this._extensionRunner.createCommandContext();

    try {
      await command.handler(args, ctx);
      return true;
    } catch (err) {
      // Emit error via extension runner
      this._extensionRunner.emitError({
        error: err instanceof Error ? err.message : String(err),
        event: "command",
        extensionPath: `command:${commandName}`,
      });
      return true;
    }
  }

  private buildExtensionResourcePaths(
    entries: { extensionPath: string; path: string }[],
  ): {
    metadata: {
      baseDir?: string;
      origin: "top-level";
      scope: "temporary";
      source: string;
    };
    path: string;
  }[] {
    return entries.map((entry) => {
      const source = this.getExtensionSourceLabel(entry.extensionPath);
      const baseDir = entry.extensionPath.startsWith("<")
        ? undefined
        : dirname(entry.extensionPath);
      return {
        metadata: {
          baseDir,
          origin: "top-level",
          scope: "temporary",
          source,
        },
        path: entry.path,
      };
    });
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  private async extendResourcesFromExtensions(
    reason: "reload" | "startup",
  ): Promise<void> {
    if (!this._extensionRunner?.hasHandlers("resources_discover")) {
      return;
    }

    const { promptPaths, skillPaths, themePaths } =
      await this._extensionRunner.emitResourcesDiscover(this._cwd, reason);

    if (
      skillPaths.length === 0 &&
      promptPaths.length === 0 &&
      themePaths.length === 0
    ) {
      return;
    }

    const extensionPaths: ResourceExtensionPaths = {
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths),
    };

    this._resourceLoader.extendResources(extensionPaths);
    this._baseSystemPrompt = this._rebuildSystemPrompt(
      this.getActiveToolNames(),
    );
    this.agent.state.systemPrompt = this._baseSystemPrompt;
  }

  // =========================================================================
  // Extension System
  // =========================================================================

  private getExtensionSourceLabel(extensionPath: string): string {
    if (extensionPath.startsWith("<")) {
      return `extension:${extensionPath.replace(/[<>]/g, "")}`;
    }
    const base = basename(extensionPath);
    const name = base.replace(/\.(ts|js)$/, "");
    return `extension:${name}`;
  }

  /**
   * Wait for any in-progress retry to complete.
   * Returns immediately if no retry is in progress.
   */
  private async waitForRetry(): Promise<void> {
    if (!this._retryPromise) {
      return;
    }

    await this._retryPromise;
    await this.agent.waitForIdle();
  }
}
