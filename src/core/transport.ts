/**
 * Transport - Connection abstraction for AgentSessionServer.
 *
 * Allows different transport implementations (WebSocket, stdio, in-memory, etc.)
 */

import type { ClientMessage, ServerMessage } from "./agent-session-server-types.js";

export interface Connection {
	send(message: ServerMessage): void;
	onMessage(handler: (message: ClientMessage) => void): void;
	onClose(handler: () => void): void;
	close(): void;
}

export interface Transport {
	acceptConnection(): Promise<Connection>;
	close(): Promise<void>;
}

export interface TransportFactory {
	create(): Transport;
}
