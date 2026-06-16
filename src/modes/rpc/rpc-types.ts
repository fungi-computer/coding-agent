/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@shiit/agent-core";

import type { SessionStats } from "../../core/agent-session.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { SourceInfo } from "../../core/source-info.js";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
  // Prompting
  | { customInstructions?: string; id?: string; type: "compact" }
  | { enabled: boolean; id?: string; type: "set_auto_compaction" }
  | { enabled: boolean; id?: string; type: "set_auto_retry" }
  | { entryId: string; id?: string; type: "fork" }
  | {
      id?: string;
      images?: ImageContent[];
      message: string;
      streamingBehavior?: "followUp" | "steer";
      type: "prompt";
    }

  // State
  | { id?: string; images?: ImageContent[]; message: string; type: "follow_up" }

  // Model
  | { id?: string; images?: ImageContent[]; message: string; type: "steer" }
  | { id?: string; level: ThinkingLevel; type: "set_thinking_level" }
  | { id?: string; mode: "all" | "one-at-a-time"; type: "set_follow_up_mode" }

  // Thinking
  | { id?: string; mode: "all" | "one-at-a-time"; type: "set_steering_mode" }
  | { id?: string; modelId: string; provider: string; type: "set_model" }

  // Queue modes
  | { id?: string; name: string; type: "set_session_name" }
  | { id?: string; outputPath?: string; type: "export_html" }

  // Compaction
  | { id?: string; parentSession?: string; type: "new_session" }
  | { id?: string; sessionPath: string; type: "switch_session" }

  // Retry
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "abort" }

  // Session
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "get_messages" }

  // Messages
  | { id?: string; type: "get_session_stats" }

  // Commands (available for invocation via prompt)
  | { id?: string; type: "get_state" };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// RPC State
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
  | {
      id: string;
      message: string;
      method: "confirm";
      timeout?: number;
      title: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      message: string;
      method: "notify";
      notifyType?: "error" | "info" | "warning";
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "editor";
      prefill?: string;
      title: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "input";
      placeholder?: string;
      timeout?: number;
      title: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "select";
      options: string[];
      timeout?: number;
      title: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "set_editor_text";
      text: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "setTitle";
      title: string;
      type: "extension_ui_request";
    }
  | {
      id: string;
      method: "setWidget";
      type: "extension_ui_request";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    };

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
  | { cancelled: true; id: string; type: "extension_ui_response" }
  | { confirmed: boolean; id: string; type: "extension_ui_response" }
  | { id: string; type: "extension_ui_response"; value: string };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
  // Prompting (async - events follow)
  | { command: "abort_retry"; id?: string; success: true; type: "response" }
  | { command: "abort"; id?: string; success: true; type: "response" }
  | {
      command: "compact";
      data: CompactionResult;
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "cycle_model";
      data: {
        isScoped: boolean;
        model: Model<any>;
        thinkingLevel: ThinkingLevel;
      } | null;
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "cycle_thinking_level";
      data: { level: ThinkingLevel } | null;
      id?: string;
      success: true;
      type: "response";
    }

  // State
  | {
      command: "export_html";
      data: { path: string };
      id?: string;
      success: true;
      type: "response";
    }

  // Model
  | { command: "follow_up"; id?: string; success: true; type: "response" }
  | {
      command: "fork";
      data: { cancelled: boolean; text: string };
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "get_available_models";
      data: { models: Model<any>[] };
      id?: string;
      success: true;
      type: "response";
    }

  // Thinking
  | {
      command: "get_commands";
      data: { commands: RpcSlashCommand[] };
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "get_fork_messages";
      data: { messages: { entryId: string; text: string }[] };
      id?: string;
      success: true;
      type: "response";
    }

  // Queue modes
  | {
      command: "get_last_assistant_text";
      data: { text: null | string };
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "get_messages";
      data: { messages: AgentMessage[] };
      id?: string;
      success: true;
      type: "response";
    }

  // Compaction
  | {
      command: "get_session_stats";
      data: SessionStats;
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "get_state";
      data: RpcSessionState;
      id?: string;
      success: true;
      type: "response";
    }

  // Retry
  | {
      command: "new_session";
      data: { cancelled: boolean };
      id?: string;
      success: true;
      type: "response";
    }
  | { command: "prompt"; id?: string; success: true; type: "response" }

  // Session
  | {
      command: "set_auto_compaction";
      id?: string;
      success: true;
      type: "response";
    }
  | { command: "set_auto_retry"; id?: string; success: true; type: "response" }
  | {
      command: "set_follow_up_mode";
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "set_model";
      data: Model<any>;
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "set_session_name";
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "set_steering_mode";
      id?: string;
      success: true;
      type: "response";
    }
  | {
      command: "set_thinking_level";
      id?: string;
      success: true;
      type: "response";
    }

  // Messages
  | { command: "steer"; id?: string; success: true; type: "response" }

  // Commands
  | {
      command: "switch_session";
      data: { cancelled: boolean };
      id?: string;
      success: true;
      type: "response";
    }

  // Error response (any command can fail)
  | {
      command: string;
      error: string;
      id?: string;
      success: false;
      type: "response";
    };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

export interface RpcSessionState {
  autoCompactionEnabled: boolean;
  followUpMode: "all" | "one-at-a-time";
  isCompacting: boolean;
  isStreaming: boolean;
  messageCount: number;
  model?: Model<any>;
  pendingMessageCount: number;
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  steeringMode: "all" | "one-at-a-time";
  thinkingLevel: ThinkingLevel;
}

// ============================================================================
// Helper type for extracting command types
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
  /** Human-readable description */
  description?: string;
  /** Command name (without leading slash) */
  name: string;
  /** What kind of command this is */
  source: "extension" | "prompt" | "skill";
  /** Source metadata for the owning resource */
  sourceInfo: SourceInfo;
}
