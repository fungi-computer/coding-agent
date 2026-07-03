/**
 * Transport - Connection abstraction for AgentSessionServer.
 *
 * Allows different transport implementations (WebSocket, stdio, in-memory, etc.)
 *
 * The TUI uses this Transport interface directly (its messages are
 * the legacy TUI shape: `resize`, `command`, `input`). The new
 * browser/CLI WebSocket clients go through
 * `agent-session-protocol.ts` instead — they wrap the agent
 * session in a per-WS coordinator and speak a different wire
 * format.
 *
 * PLAN-020: the TUI's wire format was previously called
 * `ClientMessage`/`ServerMessage` at the top level, colliding
 * with the new WS protocol's same-named types. The TUI shape is
 * local to the Transport layer and has been renamed to
 * `ConnectionMessage`. The WS protocol's `ClientMessage`/
 * `ServerMessage` keep the canonical names.
 */

import type {
  SessionCommand,
  AgentSessionSyncEvent,
} from "./agent-session-server-types.js";

/** TUI client → server, over a Transport connection. */
export type ConnectionMessage =
  | { cols: number; rows: number; sessionId: string; type: "resize" }
  | { command: SessionCommand; sessionId: string; type: "command" }
  | { data: string; sessionId: string; type: "input" };

/** TUI server → client, over a Transport connection. */
export type ServerToClientMessage =
  | { event: AgentSessionSyncEvent; sessionId: string; type: "event" }
  | { message: string; sessionId: string; type: "error" }
  | { sessionId: string; type: "welcome" };

export interface Connection {
  close(): void;
  onClose(handler: () => void): void;
  onMessage(handler: (message: ConnectionMessage) => void): void;
  send(message: ServerToClientMessage): void;
}

export interface Transport {
  acceptConnection(): Promise<Connection>;
  close(): Promise<void>;
}

export interface TransportFactory {
  create(): Transport;
}
