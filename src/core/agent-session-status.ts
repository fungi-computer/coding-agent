import type { AgentSessionSyncEvent } from "./agent-session-server-types.js";

export type AgentRuntimeStatus =
  | "compacting"
  | "idle"
  | "retrying"
  | "sending"
  | "streaming"
  | "thinking";

/**
 * Derive the canonical agent runtime status from a session event.
 *
 * This is the single source of truth for both the chat composer's
 * status dot and the dashboard session aura. Keep it in sync with
 * `interpretEvent` in `@fungi.computer/chat`.
 */
export function deriveAgentRuntimeStatus(
  event: AgentSessionSyncEvent,
): AgentRuntimeStatus | null {
  switch (event.type) {
    case "agent_start":
      return "thinking";
    case "agent_end":
      return "idle";
    case "message_start": {
      const role = (event.message as { role?: string } | undefined)?.role;
      if (role === "assistant") return "streaming";
      return null;
    }
    case "message_end": {
      const msg = event.message as { role?: string; content?: unknown };
      if (msg.role === "toolResult" || msg.role === "user") return null;
      const hasToolCalls = Array.isArray(msg.content)
        ? msg.content.some((c: any) => c.type === "toolCall")
        : false;
      return hasToolCalls ? "thinking" : "idle";
    }
    case "compaction_start":
      return "compacting";
    case "compaction_end":
      return "idle";
    case "auto_retry_start":
      return "retrying";
    case "auto_retry_end": {
      const ev = event as { success: boolean };
      return ev.success ? null : "idle";
    }
    case "tool_execution_start":
      return "thinking";
    default:
      return null;
  }
}
