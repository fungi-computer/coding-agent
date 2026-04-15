/**
 * AgentSessionServer - Types for the server that manages AgentSession instances
 * and broadcasts events to connected clients over WebSocket.
 *
 * @module
 */

import type { AgentMessage, ThinkingLevel } from "@shiit/agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { ContextUsage } from "./extensions/types.js";
import type { BranchSummaryEntry, SessionEntry } from "./session-manager.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import type { SourceInfo } from "./source-info.js";

// ============================================================================
// Session Command (Client → Server)
// ============================================================================

/** Commands a client can send to the server */
export type SessionCommand =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "set_model"; modelId: string; provider?: string }
	| { type: "set_thinking_level"; level: ThinkingLevel }
	| { type: "set_tools"; toolNames: string[] }
	| { type: "navigate_tree"; leafId: string }
	| { type: "compact"; reason?: "manual" | "threshold" | "overflow" }
	| { type: "submit_user_bash"; command: string; excludeFromContext?: boolean };

// ============================================================================
// Client Message (Client → Server, over WebSocket)
// ============================================================================

/** Raw messages from client over WebSocket */
export type ClientMessage =
	| { type: "command"; sessionId: string; command: SessionCommand }
	| { type: "input"; sessionId: string; data: string }
	| { type: "resize"; sessionId: string; cols: number; rows: number };

// ============================================================================
// Server Message (Server → Client, over WebSocket)
// ============================================================================

/** Messages from server to client over WebSocket */
export type ServerMessage =
	| { type: "welcome"; sessionId: string }
	| { type: "snapshot"; sessionId: string; data: SessionSnapshot }
	| { type: "event"; sessionId: string; sequenceId: number; event: AgentSessionSyncEvent }
	| { type: "error"; sessionId: string; message: string };

// ============================================================================
// AgentSessionSyncEvent (mirrors AgentSessionEvent for wire format)
// ============================================================================

/**
 * Events that can be sent from server to client.
 * This is a subset/superset of AgentSessionEvent adapted for sync.
 */
export type AgentSessionSyncEvent =
	// Lifecycle
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start"; turnIndex: number }
	| { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: AgentMessage[] }

	// Messages
	| { type: "message_start"; message: AgentMessage; id: string }
	| { type: "message_update"; message: AgentMessage; delta: string; thinkingDelta?: string; id: string }
	| { type: "message_end"; message: AgentMessage; id: string }

	// Tools
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; result: unknown; isError: boolean }

	// Queue
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }

	// Compaction
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result?: unknown; aborted: boolean; willRetry: boolean }

	// Retry
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number }

	// Session state changes (Phase 1 events)
	| { type: "model_changed"; model?: Model<any>; previousModel?: Model<any>; source: "set" | "cycle" | "restore" }
	| { type: "thinking_level_changed"; level: ThinkingLevel; availableLevels: readonly ThinkingLevel[] }
	| { type: "tools_changed"; activeToolNames: readonly string[] }
	| { type: "tree_changed"; oldLeafId: string | null; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { type: "session_metadata_changed"; sessionName?: string }
	| { type: "label_changed"; targetId: string; label: string | undefined }
	| { type: "context_usage_changed"; usage?: ContextUsage }
	| { type: "resources_changed"; resources: SessionResources }

	// Bash
	| { type: "bash_start"; command: string; excludeFromContext: boolean }
	| { type: "bash_output"; command: string; chunk: string }
	| { type: "bash_end"; command: string; result?: unknown; excludeFromContext: boolean };

// ============================================================================
// Session Resources
// ============================================================================

export interface SessionResources {
	extensions: Array<{ path: string; sourceInfo?: SourceInfo }>;
	extensionErrors: Array<{ path: string; error: string }>;
	skills: Array<{ name: string; filePath: string; sourceInfo?: SourceInfo }>;
	skillDiagnostics: ResourceDiagnostic[];
	prompts: Array<{ name: string; filePath: string; sourceInfo?: SourceInfo }>;
	promptDiagnostics: ResourceDiagnostic[];
	themes: Array<{ name: string; sourcePath?: string; sourceInfo?: SourceInfo }>;
	themeDiagnostics: ResourceDiagnostic[];
}

// ============================================================================
// Session Snapshot (Full state for join/reconnect)
// ============================================================================

/**
 * Full session state for sending to clients on join or reconnect.
 * Contains all data needed to render the current session state.
 */
export interface SessionSnapshot {
	// Identity
	sessionId: string;
	cwd: string;
	sessionName?: string;

	// Tree position
	leafId: string | null;
	branchEntries: SessionEntry[];

	// Model and thinking
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: readonly ThinkingLevel[];
	activeToolNames: readonly string[];

	// Queue
	queue: {
		steering: readonly string[];
		followUp: readonly string[];
	};

	// Live/streaming state
	agent: {
		isStreaming: boolean;
		currentMessage?: AgentMessage;
		pendingToolCalls: Array<{
			toolCallId: string;
			toolName: string;
			args: unknown;
			partialResult?: unknown;
		}>;
	};

	// Status
	compaction?: {
		active: boolean;
		reason?: "manual" | "threshold" | "overflow";
	};
	retry?: {
		active: boolean;
		attempt?: number;
		maxAttempts?: number;
		delayMs?: number;
		errorMessage?: string;
	};
	bash?: {
		active: boolean;
		command?: string;
		outputSoFar?: string;
		excludeFromContext?: boolean;
	};

	// Context usage
	contextUsage?: ContextUsage;

	// Resources
	resources: SessionResources;
}

// ============================================================================
// Global Server Types
// ============================================================================

/** Events not tied to a specific session */
export type GlobalServerEvent =
	| { type: "server_connected" }
	| { type: "server_shutdown" }
	| { type: "session_created"; sessionId: string; info: SessionListItem }
	| { type: "session_updated"; sessionId: string; info: SessionListItem }
	| { type: "session_deleted"; sessionId: string }
	| { type: "session_status_changed"; sessionId: string; status: "idle" | "busy" | "retry" };

export interface SessionListItem {
	id: string;
	name?: string;
	cwd: string;
	createdAt: number;
	modifiedAt: number;
	messageCount: number;
}

// ============================================================================
// Session Factory (for creating AgentSession instances)
// ============================================================================

import type { AgentSession } from "./agent-session.js";

export interface SessionFactory {
	createSession(options: { sessionId: string; cwd: string }): Promise<AgentSession>;
	closeSession(sessionId: string): Promise<void>;
}

// ============================================================================
// Client Connection
// ============================================================================

export interface ClientConnection {
	sessionId?: string;
	lastSequenceId: number;
}
