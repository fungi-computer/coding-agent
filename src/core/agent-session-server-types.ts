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
import type { AgentRuntimeStatus } from "./agent-session-status.js";

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
  | { position: number; sessionId: string; type: "queued" }
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
  | { kind: "queue_full"; terminal: false; type: "error" }
  | { kind: "followups_full"; terminal: false; type: "error" }
  | {
      cost?: number;
      type: "context_usage_changed";
      usage?: ContextUsage;
    };

// ============================================================================
// Client/Server Message (over WebSocket)
//
// PLAN-020: the canonical wire-format types live in
// `agent-session-protocol.ts`. Re-exported here for back-compat
// with existing imports. New code should import from the protocol
// module directly.
//
// The previous `ClientMessage`/`ServerMessage` declared here was a
// lie: `ServerMessage` declared `{ data: SessionSnapshot; ... }` for
// the `snapshot` variant but the wire actually emitted
// `{ snapshot: SessionSnapshot; ... }`. The chat was reading the
// wire correctly; the type was wrong. The protocol module is now
// the source of truth, and a round-trip test pins it.
// ============================================================================

export {
  parseClientMessage,
  parseServerMessage,
  serializeClientMessage,
  serializeServerMessage,
} from "./agent-session-protocol.js";
export type {
  ClientMessage,
  Identity,
  PersistedAttachment,
  ServerMessage,
} from "./agent-session-protocol.js";

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
      status: AgentRuntimeStatus;
      type: "session_status_changed";
    }
  | { sessionId: string; type: "session_deleted" }
  | { sessionId: string; type: "session_loaded" }
  | { sessionId: string; type: "session_unloaded" }
  | { type: "server_connected" }
  | { type: "server_shutdown" };

// ============================================================================
// Session Snapshot (Full state for join/reconnect)
// ============================================================================

export interface ClientConnection {
  lastSequenceId: number;
  sessionId?: string;
}

/** Commands a client can send to the server */
export type SessionCommand =
  | { leafId: string; type: "navigate_tree" }
  | { level: ThinkingLevel; type: "set_thinking_level" }
  | { modelId: string; provider?: string; type: "set_model" }
  | {
      lane?: "interactive" | "cron";
      reason?: "manual" | "overflow" | "threshold";
      type: "compact";
    }
  | { lane?: "interactive" | "cron"; text: string; type: "prompt" }
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
  preview?: string;
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

  // LLM-ready messages, ordered from earliest to latest. This is
  // the full conversation as the LLM sees it (compacted if a
  // compaction entry is in the branch). PLAN-019: replaces
  // `branchEntries` to keep snapshot payloads small. PLAN-019
  // follow-up (Phase B) lets the LLM context cache absorb repeat
  // builds of this array.
  messages: AgentMessage[];

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
  // Pagination
  /**
   * True when `messages` contains only the most recent N (see
   * SNAPSHOT_MESSAGE_LIMIT in agent-session-server). The client
   * should backfill older history over HTTP.
   */
  hasMoreMessages: boolean;

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
