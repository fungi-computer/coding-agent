/**
 * InMemoryTransport - For testing AgentSessionServer without network.
 *
 * PLAN-020: the TUI's wire format is now `ConnectionMessage` /
 * `ServerToClientMessage` (defined in `transport.ts`). The old
 * `ClientMessage`/`ServerMessage` names now belong to the WS
 * protocol in `agent-session-protocol.ts`.
 */

import type { Connection, Transport } from "./transport.js";
import type { ConnectionMessage, ServerToClientMessage } from "./transport.js";

export class InMemoryConnection implements Connection {
  private closeHandlers = new Set<() => void>();
  private messageHandlers = new Set<(message: ConnectionMessage) => void>();
  private messages: ConnectionMessage[] = [];
  private open = true;

  close(): void {
    this.open = false;
    this.closeHandlers.forEach((h) => h());
  }

  getReceivedMessages(): ServerToClientMessage[] {
    return this.messages as unknown as ServerToClientMessage[];
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onMessage(handler: (message: ConnectionMessage) => void): void {
    this.messageHandlers.add(handler);
    for (const msg of this.messages) {
      handler(msg);
    }
    this.messages = [];
  }

  send(message: ServerToClientMessage): void {
    if (!this.open) return;
    this.messages.push(message as unknown as ConnectionMessage);
  }

  simulateMessage(msg: ConnectionMessage): void {
    this.messageHandlers.forEach((h) => h(msg));
  }
}

export class InMemoryTransport implements Transport {
  private acceptHandler: ((conn: Connection) => void) | null = null;
  private closed = false;
  private connections: InMemoryConnection[] = [];

  async acceptConnection(): Promise<Connection> {
    if (this.closed) {
      throw new Error("Transport closed");
    }
    const conn = new InMemoryConnection();
    this.connections.push(conn);
    this.acceptHandler?.(conn);
    return conn;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections = [];
  }

  onAccept(handler: (conn: Connection) => void): void {
    this.acceptHandler = handler;
  }
}
