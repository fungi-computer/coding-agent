/**
 * InMemoryTransport - For testing AgentSessionServer without network.
 */

import type { Connection, Transport } from "./transport.js";
import type {
  ClientMessage,
  ServerMessage,
} from "./agent-session-server-types.js";

export class InMemoryTransport implements Transport {
  private connections: InMemoryConnection[] = [];
  private acceptHandler: ((conn: Connection) => void) | null = null;
  private closed = false;

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

export class InMemoryConnection implements Connection {
  private messageHandlers: Set<(message: ClientMessage) => void> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private messages: ClientMessage[] = [];
  private open = true;

  send(message: ServerMessage): void {
    if (!this.open) return;
    this.messages.push(message as any);
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this.messageHandlers.add(handler);
    for (const msg of this.messages) {
      handler(msg);
    }
    this.messages = [];
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    this.open = false;
    this.closeHandlers.forEach((h) => h());
  }

  simulateMessage(msg: ClientMessage): void {
    this.messageHandlers.forEach((h) => h(msg));
  }

  getReceivedMessages(): ServerMessage[] {
    return this.messages as unknown as ServerMessage[];
  }
}
