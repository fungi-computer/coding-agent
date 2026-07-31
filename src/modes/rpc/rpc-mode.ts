/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { nanoid } from "@shiit/id";

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from "./rpc-types.js";

import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";

// Re-export types for consumers
export type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from "./rpc-types.js";

/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
  runtimeHost: AgentSessionRuntime,
): Promise<never> {
  takeOverStdout();
  let session = runtimeHost.session;
  let unsubscribe: (() => void) | undefined;

  const output = (obj: object | RpcExtensionUIRequest | RpcResponse) => {
    writeRawStdout(serializeJsonLine(obj));
  };

  const success = <T extends RpcCommand["type"]>(
    id: string | undefined,
    command: T,
    data?: null | object,
  ): RpcResponse => {
    if (data === undefined) {
      return { command, id, success: true, type: "response" } as RpcResponse;
    }
    return {
      command,
      data,
      id,
      success: true,
      type: "response",
    } as RpcResponse;
  };

  const error = (
    id: string | undefined,
    command: string,
    message: string,
  ): RpcResponse => {
    return { command, error: message, id, success: false, type: "response" };
  };

  // Pending extension UI requests waiting for response
  const pendingExtensionRequests = new Map<
    string,
    { reject: (error: Error) => void; resolve: (value: any) => void }
  >();

  // Shutdown request flag
  let shutdownRequested = false;

  /** Helper for dialog methods with signal/timeout support */
  function createDialogPromise<T>(
    opts: ExtensionUIDialogOptions | undefined,
    defaultValue: T,
    request: Record<string, unknown>,
    parseResponse: (response: RpcExtensionUIResponse) => T,
  ): Promise<T> {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

    const id = nanoid();
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        pendingExtensionRequests.delete(id);
      };

      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }

      pendingExtensionRequests.set(id, {
        reject,
        resolve: (response: RpcExtensionUIResponse) => {
          cleanup();
          resolve(parseResponse(response));
        },
      });
      output({
        id,
        type: "extension_ui_request",
        ...request,
      } as RpcExtensionUIRequest);
    });
  }

  /**
   * Create an extension UI context that uses the RPC protocol.
   */
  const createExtensionUIContext = (): ExtensionUIContext => ({
    confirm: (title: string, message: string, opts: any) =>
      createDialogPromise(
        opts,
        false,
        { message, method: "confirm", timeout: opts?.timeout, title },
        (r) =>
          "cancelled" in r && r.cancelled
            ? false
            : "confirmed" in r
              ? r.confirmed
              : false,
      ),

    async custom() {
      // Custom UI not supported in RPC mode
      return undefined as never;
    },

    async editor(title: string, prefill?: string): Promise<string | undefined> {
      const id = nanoid();
      return new Promise((resolve, reject) => {
        pendingExtensionRequests.set(id, {
          reject,
          resolve: (response: RpcExtensionUIResponse) => {
            if ("cancelled" in response && response.cancelled) {
              resolve(undefined);
            } else if ("value" in response) {
              resolve(response.value);
            } else {
              resolve(undefined);
            }
          },
        });
        output({
          id,
          method: "editor",
          prefill,
          title,
          type: "extension_ui_request",
        } as RpcExtensionUIRequest);
      });
    },

    getAllThemes() {
      return [];
    },

    getEditorText(): string {
      // Synchronous method can't wait for RPC response
      // Host should track editor state locally if needed
      return "";
    },

    getTheme(_name: string) {
      return undefined;
    },

    getToolsExpanded() {
      // Tool expansion not supported in RPC mode - no TUI
      return false;
    },

    input: (title: string, placeholder: string, opts: any) =>
      createDialogPromise(
        opts,
        undefined,
        { method: "input", placeholder, timeout: opts?.timeout, title },
        (r) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? r.value
              : undefined,
      ),

    notify(message: string, type?: "error" | "info" | "warning"): void {
      // Fire and forget - no response needed
      output({
        id: nanoid(),
        message,
        method: "notify",
        notifyType: type,
        type: "extension_ui_request",
      } as RpcExtensionUIRequest);
    },

    onTerminalInput(): () => void {
      // Raw terminal input not supported in RPC mode
      return () => {};
    },

    pasteToEditor(text: string): void {
      // Paste handling not supported in RPC mode - falls back to setEditorText
      this.setEditorText(text);
    },

    select: (title: string, options: any, opts: any) =>
      createDialogPromise(
        opts,
        undefined,
        { method: "select", options, timeout: opts?.timeout, title },
        (r) =>
          "cancelled" in r && r.cancelled
            ? undefined
            : "value" in r
              ? r.value
              : undefined,
      ),

    setEditorComponent(): void {
      // Custom editor components not supported in RPC mode
    },

    setEditorText(text: string): void {
      // Fire and forget - host can implement editor control
      output({
        id: nanoid(),
        method: "set_editor_text",
        text,
        type: "extension_ui_request",
      } as RpcExtensionUIRequest);
    },

    setFooter(_factory: unknown): void {
      // Custom footer not supported in RPC mode - requires TUI access
    },

    setHeader(_factory: unknown): void {
      // Custom header not supported in RPC mode - requires TUI access
    },

    setHiddenThinkingLabel(_label?: string): void {
      // Hidden thinking label not supported in RPC mode - requires TUI message rendering access
    },

    setStatus(key: string, text: string | undefined): void {
      // Fire and forget - no response needed
      output({
        id: nanoid(),
        method: "setStatus",
        statusKey: key,
        statusText: text,
        type: "extension_ui_request",
      } as RpcExtensionUIRequest);
    },

    setTheme(_theme: any | string) {
      // Theme switching not supported in RPC mode
      return {
        error: "Theme switching not supported in RPC mode",
        success: false,
      };
    },

    setTitle(title: string): void {
      // Fire and forget - host can implement terminal title control
      output({
        id: nanoid(),
        method: "setTitle",
        title,
        type: "extension_ui_request",
      } as RpcExtensionUIRequest);
    },

    setToolsExpanded(_expanded: boolean) {
      // Tool expansion not supported in RPC mode - no TUI
    },

    setWidget(
      key: string,
      content: unknown,
      options?: ExtensionWidgetOptions,
    ): void {
      // Only support string arrays in RPC mode - factory functions are ignored
      if (content === undefined || Array.isArray(content)) {
        output({
          id: nanoid(),
          method: "setWidget",
          type: "extension_ui_request",
          widgetKey: key,
          widgetLines: content as string[] | undefined,
          widgetPlacement: options?.placement,
        } as RpcExtensionUIRequest);
      }
      // Component factories are not supported in RPC mode - would need TUI access
    },

    setWorkingMessage(_message?: string): void {
      // Working message not supported in RPC mode - requires TUI loader access
    },

    get theme() {
      return undefined;
    },
  });

  const rebindSession = async (): Promise<void> => {
    session = runtimeHost.session;
    await session.bindExtensions({
      commandContextActions: {
        fork: async (entryId: string) => {
          const result = await runtimeHost.fork(entryId);
          if (!result.cancelled) {
            await rebindSession();
          }
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId: string, options: any) => {
          const result = await session.navigateTree(targetId, {
            customInstructions: options?.customInstructions,
            label: options?.label,
            replaceInstructions: options?.replaceInstructions,
            summarize: options?.summarize,
          });
          return { cancelled: result.cancelled };
        },
        newSession: async (options: any) => {
          const result = await runtimeHost.newSession(options);
          if (!result.cancelled) {
            await rebindSession();
          }
          return result;
        },
        reload: async () => {
          await session.reload();
        },
        switchSession: async (sessionPath: string) => {
          const result = await runtimeHost.switchSession(sessionPath);
          if (!result.cancelled) {
            await rebindSession();
          }
          return result;
        },
        waitForIdle: () => session.agent.waitForIdle(),
      },
      onError: (err: any) => {
        output({
          error: err.error,
          event: err.event,
          extensionPath: err.extensionPath,
          type: "extension_error",
        });
      },
      shutdownHandler: () => {
        shutdownRequested = true;
      },
      uiContext: createExtensionUIContext(),
    });

    unsubscribe?.();
    unsubscribe = session.subscribe((event) => {
      output(event);
    });
  };

  await rebindSession();

  // Handle a single command
  const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
    const id = command.id;

    switch (command.type) {
      // =================================================================
      // Prompting
      // =================================================================

      case "abort": {
        await session.abort();
        return success(id, "abort");
      }

      case "abort_retry": {
        session.abortRetry();
        return success(id, "abort_retry");
      }

      case "compact": {
        const result = await session.compact(command.customInstructions);
        return success(id, "compact", result);
      }

      case "cycle_model": {
        const result = await session.cycleModel();
        if (!result) {
          return success(id, "cycle_model", null);
        }
        return success(id, "cycle_model", result);
      }

      case "cycle_thinking_level": {
        const level = session.cycleThinkingLevel();
        if (!level) {
          return success(id, "cycle_thinking_level", null);
        }
        return success(id, "cycle_thinking_level", { level });
      }

      // =================================================================
      // State
      // =================================================================

      case "follow_up": {
        await session.followUp(command.message, command.images);
        return success(id, "follow_up");
      }

      // =================================================================
      // Model
      // =================================================================

      case "fork": {
        const result = await runtimeHost.fork(command.entryId);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, "fork", {
          cancelled: result.cancelled,
          text: result.selectedText,
        });
      }

      case "get_available_models": {
        const models = await session.modelRegistry.getAvailable();
        return success(id, "get_available_models", { models });
      }

      case "get_commands": {
        const commands: RpcSlashCommand[] = [];

        for (const command of session.extensionRunner?.getRegisteredCommands() ??
          []) {
          commands.push({
            description: command.description,
            name: command.invocationName,
            source: "extension",
            sourceInfo: command.sourceInfo,
          });
        }

        for (const template of session.promptTemplates) {
          commands.push({
            description: template.description,
            name: template.name,
            source: "prompt",
            sourceInfo: template.sourceInfo,
          });
        }

        for (const skill of session.resourceLoader.getSkills().skills) {
          commands.push({
            description: skill.description,
            name: `skill:${skill.name}`,
            source: "skill",
            sourceInfo: skill.sourceInfo,
          });
        }

        return success(id, "get_commands", { commands });
      }

      // =================================================================
      // Thinking
      // =================================================================

      case "get_fork_messages": {
        const messages = session.getUserMessagesForForking();
        return success(id, "get_fork_messages", { messages });
      }

      case "get_last_assistant_text": {
        const text = session.getLastAssistantText();
        return success(id, "get_last_assistant_text", { text });
      }

      // =================================================================
      // Queue Modes
      // =================================================================

      case "get_messages": {
        return success(id, "get_messages", { messages: session.messages });
      }

      case "get_session_stats": {
        const stats = session.getSessionStats();
        return success(id, "get_session_stats", stats);
      }

      // =================================================================
      // Compaction
      // =================================================================

      case "get_state": {
        const state: RpcSessionState = {
          autoCompactionEnabled: session.autoCompactionEnabled,
          followUpMode: session.followUpMode,
          isCompacting: session.isCompacting,
          isStreaming: session.isStreaming,
          messageCount: session.messages.length,
          model: session.model,
          pendingMessageCount: session.pendingMessageCount,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          steeringMode: session.steeringMode,
          thinkingLevel: session.thinkingLevel,
        };
        return success(id, "get_state", state);
      }

      case "new_session": {
        const options = command.parentSession
          ? { parentSession: command.parentSession }
          : undefined;
        const result = await runtimeHost.newSession(options);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, "new_session", result);
      }

      // =================================================================
      // Retry
      // =================================================================

      case "prompt": {
        // Don't await - events will stream
        // Extension commands are executed immediately, file prompt templates are expanded
        // If streaming and streamingBehavior specified, queues via steer/followUp
        session
          .prompt(command.message, {
            images: command.images,
            source: "rpc",
            streamingBehavior: command.streamingBehavior,
          })
          .catch((e) => output(error(id, "prompt", e.message)));
        return success(id, "prompt");
      }

      case "set_auto_compaction": {
        session.setAutoCompactionEnabled(command.enabled);
        return success(id, "set_auto_compaction");
      }

      // =================================================================
      // Session
      // =================================================================

      case "set_auto_retry": {
        session.setAutoRetryEnabled(command.enabled);
        return success(id, "set_auto_retry");
      }

      case "set_follow_up_mode": {
        session.setFollowUpMode(command.mode);
        return success(id, "set_follow_up_mode");
      }

      case "set_model": {
        const models = await session.modelRegistry.getAvailable();
        const model = models.find(
          (m) => m.provider === command.provider && m.id === command.modelId,
        );
        if (!model) {
          return error(
            id,
            "set_model",
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        }
        await session.setModel(model);
        return success(id, "set_model", model);
      }

      case "set_session_name": {
        const name = command.name.trim();
        if (!name) {
          return error(id, "set_session_name", "Session name cannot be empty");
        }
        session.setSessionName(name);
        return success(id, "set_session_name");
      }

      case "set_steering_mode": {
        session.setSteeringMode(command.mode);
        return success(id, "set_steering_mode");
      }

      case "set_thinking_level": {
        session.setThinkingLevel(command.level);
        return success(id, "set_thinking_level");
      }

      // =================================================================
      // Messages
      // =================================================================

      case "steer": {
        await session.steer(command.message, command.images);
        return success(id, "steer");
      }

      // =================================================================
      // Commands (available for invocation via prompt)
      // =================================================================

      case "switch_session": {
        const result = await runtimeHost.switchSession(command.sessionPath);
        if (!result.cancelled) {
          await rebindSession();
        }
        return success(id, "switch_session", result);
      }

      default: {
        const unknownCommand = command as { type: string };
        return error(
          undefined,
          unknownCommand.type,
          `Unknown command: ${unknownCommand.type}`,
        );
      }
    }
  };

  /**
   * Check if shutdown was requested and perform shutdown if so.
   * Called after handling each command when waiting for the next command.
   */
  let detachInput = () => {};

  async function shutdown(): Promise<never> {
    unsubscribe?.();
    await runtimeHost.dispose();
    detachInput();
    process.stdin.pause();
    process.exit(0);
  }

  async function checkShutdownRequested(): Promise<void> {
    if (!shutdownRequested) return;
    await shutdown();
  }

  const handleInputLine = async (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (parseError: unknown) {
      output(
        error(
          undefined,
          "parse",
          `Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        ),
      );
      return;
    }

    // Handle extension UI responses
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      parsed.type === "extension_ui_response"
    ) {
      const response = parsed as RpcExtensionUIResponse;
      const pending = pendingExtensionRequests.get(response.id);
      if (pending) {
        pendingExtensionRequests.delete(response.id);
        pending.resolve(response);
      }
      return;
    }

    const command = parsed as RpcCommand;
    try {
      const response = await handleCommand(command);
      output(response);
      await checkShutdownRequested();
    } catch (commandError: unknown) {
      output(
        error(
          command.id,
          command.type,
          commandError instanceof Error
            ? commandError.message
            : String(commandError),
        ),
      );
    }
  };

  const onInputEnd = () => {
    void shutdown();
  };
  process.stdin.on("end", onInputEnd);

  detachInput = (() => {
    const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
      void handleInputLine(line);
    });
    return () => {
      detachJsonl();
      process.stdin.off("end", onInputEnd);
    };
  })();

  // Keep process alive forever
  return new Promise(() => {});
}
