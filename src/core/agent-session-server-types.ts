/**
 * AgentSessionServer - Types for the server that manages AgentSession instances
 * and broadcasts events to connected clients over WebSocket.
 *
 * @module
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "@shiit/agent-core";

import type { ResourceDiagnostic } from "./diagnostics.js";
import type { ContextUsage } from "./extensions/types.js";
import type { BranchSummaryEntry, SessionEntry } from "./session-manager.js";
import type { SourceInfo } from "./source-info.js";

// ============================================================================
// Session Command (Client → Server)
// ============================================================================

/**
 * Events that can be sent from server to client.
 * This is a subset/superset of AgentSessionEvent adapted for sync.
 */
export type AgentSessionSyncEvent =
  // Lifecycle
  | {
      aborted: boolean;
      reason: "manual" | "overflow" | "threshold";
      result?: unknown;
      type: "compaction_end";
      willRetry: boolean;
    }
  | { activeToolNames: readonly string[]; type: "tools_changed" }
  | {
      args: unknown;
      toolCallId: string;
      toolName: string;
      type: "tool_execution_start";
    }
  | {
      attempt: number;
      delayMs: number;
      errorMessage: string;
      maxAttempts: number;
      type: "auto_retry_start";
    }

  // Messages
  | { attempt: number; success: boolean; type: "auto_retry_end" }
  | {
      availableLevels: readonly ThinkingLevel[];
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

  // Tools
  | {
      followUp: readonly string[];
      steering: readonly string[];
      type: "queue_update";
    }
  | { id: string; message: AgentMessage; type: "message_end" }
  | { id: string; message: AgentMessage; type: "message_start" }

  // Queue
  | {
      isError: boolean;
      result: unknown;
      toolCallId: string;
      type: "tool_execution_end";
    }

  // Compaction
  | { label: string | undefined; targetId: string; type: "label_changed" }
  | {
      message: AgentMessage;
      toolResults: AgentMessage[];
      turnIndex: number;
      type: "turn_end";
    }

  // Retry
  | {
      model?: Model<any>;
      previousModel?: Model<any>;
      source: "cycle" | "restore" | "set";
      type: "model_changed";
    }
  | {
      newLeafId: null | string;
      oldLeafId: null | string;
      summaryEntry?: BranchSummaryEntry;
      type: "tree_changed";
    }

  // Session state changes (Phase 1 events)
  | {
      partialResult: unknown;
      toolCallId: string;
      type: "tool_execution_update";
    }
  | { reason: "manual" | "overflow" | "threshold"; type: "compaction_start" }
  | { resources: SessionResources; type: "resources_changed" }
  | { sessionName?: string; type: "session_metadata_changed" }
  | { turnIndex: number; type: "turn_start" }
  | { type: "agent_end" }
  | { type: "agent_start" }
  | { cost?: number; type: "context_usage_changed"; usage?: ContextUsage };

// ============================================================================
// Client Message (Client → Server, over WebSocket)
// ============================================================================

export interface ClientConnection {
  lastSequenceId: number;
  sessionId?: string;
}

// ============================================================================
// Server Message (Server → Client, over WebSocket)
// ============================================================================

/** Raw messages from client over WebSocket */
export type ClientMessage =
  | { cols: number; rows: number; sessionId: string; type: "resize" }
  | { command: SessionCommand; sessionId: string; type: "command" }
  | { data: string; sessionId: string; type: "input" };

// ============================================================================
// AgentSessionSyncEvent (mirrors AgentSessionEvent for wire format)
// ============================================================================

/** Events not tied to a specific session */
export type GlobalServerEvent =
  | { info: SessionListItem; sessionId: string; type: "session_created" }
  | { info: SessionListItem; sessionId: string; type: "session_updated" }
  | { name: string; sessionId: string; type: "session_renamed" }
  | {
      sessionId: string;
      status: "busy" | "idle" | "retry";
      type: "session_status_changed";
    }
  | { sessionId: string; type: "session_deleted" }
  | { type: "server_connected" }
  | { type: "server_shutdown" };

// ============================================================================
// Session Resources
// ============================================================================

/** Messages from server to client over WebSocket */
export type ServerMessage =
  | { data: SessionSnapshot; sessionId: string; type: "snapshot" }
  | {
      event: AgentSessionSyncEvent;
      sequenceId: number;
      sessionId: string;
      type: "event";
    }
  | { message: string; sessionId: string; type: "error" }
  | { sessionId: string; type: "welcome" };

// ============================================================================
// Session Snapshot (Full state for join/reconnect)
// ============================================================================

/** Commands a client can send to the server */
export type SessionCommand =
  | { leafId: string; type: "navigate_tree" }
  | { level: ThinkingLevel; type: "set_thinking_level" }
  | { modelId: string; provider?: string; type: "set_model" }
  | { reason?: "manual" | "overflow" | "threshold"; type: "compact" }
  | { text: string; type: "prompt" }
  | { toolNames: string[]; type: "set_tools" }
  | { type: "abort" };

// ============================================================================
// Global Server Types
// ============================================================================

export interface SessionFactory {
  closeSession(sessionId: string): Promise<void>;
  createSession(options: {
    cwd: string;
    sessionId: string;
  }): Promise<AgentSession>;
}

export interface SessionListItem {
  createdAt: number;
  cwd: string;
  id: string;
  messageCount: number;
  modifiedAt: number;
  name?: string;
}

// ============================================================================
// Session Factory (for creating AgentSession instances)
// ============================================================================

import type { AgentSession } from "./agent-session.js";

export interface SessionResources {
  extensionErrors: { error: string; path: string }[];
  extensions: { path: string; sourceInfo?: SourceInfo }[];
  promptDiagnostics: ResourceDiagnostic[];
  prompts: { filePath: string; name: string; sourceInfo?: SourceInfo }[];
  skillDiagnostics: ResourceDiagnostic[];
  skills: { filePath: string; name: string; sourceInfo?: SourceInfo }[];
  themeDiagnostics: ResourceDiagnostic[];
  themes: { name: string; sourceInfo?: SourceInfo; sourcePath?: string }[];
}

// ============================================================================
// Client Connection
// ============================================================================

/**
 * Full session state for sending to clients on join or reconnect.
 * Contains all data needed to render the current session state.
 */
export interface SessionSnapshot {
  activeToolNames: readonly string[];
  // Live/streaming state
  agent: {
    currentMessage?: AgentMessage;
    currentMessageId?: string;
    isStreaming: boolean;
    pendingToolCalls: {
      args: unknown;
      partialResult?: unknown;
      toolCallId: string;
      toolName: string;
    }[];
  };
  availableThinkingLevels: readonly ThinkingLevel[];

  branchEntries: SessionEntry[];
  // Status
  compaction?: {
    active: boolean;
    reason?: "manual" | "overflow" | "threshold";
  };

  // Context usage
  contextUsage?: ContextUsage;
  // Session cost (accumulated from assistant message usage)
  cost?: number;
  cwd: string;
  // Tree position
  leafId: null | string;
  // Model and thinking
  model?: Model<any>;

  // Queue
  queue: {
    followUp: readonly string[];
    steering: readonly string[];
  };

  // Resources
  resources: SessionResources;

  /** Derived agent status so new clients know what the agent is doing right now. */
  status?: "idle" | "thinking" | "streaming" | "compacting";

  retry?: {
    active: boolean;
    attempt?: number;
    delayMs?: number;
    errorMessage?: string;
    maxAttempts?: number;
  };
  // Identity
  sessionId: string;

  sessionName?: string;

  thinkingLevel: ThinkingLevel;
}
