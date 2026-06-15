/**
 * Client-side exports for @shiit/coding-agent.
 *
 * These exports are safe to use in browser environments.
 * They do NOT depend on Node.js APIs (fs, path, __dirname, etc.).
 */

export {
  AgentSessionClient,
  type ClientTransport,
} from "./core/agent-session-client.js";
export type {
  AgentSessionSyncEvent,
  ClientMessage,
  GlobalServerEvent,
  ServerMessage,
  SessionCommand,
  SessionFactory,
  SessionListItem,
  SessionSnapshot,
} from "./core/agent-session-server-types.js";
export type { SessionStore } from "./core/session-store.js";
export {
  type Connection,
  Transport,
  type TransportFactory,
} from "./core/transport.js";
export { WebSocketClientTransport } from "./core/websocket-client-transport.js";
