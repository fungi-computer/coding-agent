/**
 * InMemoryTransport - For testing AgentSessionServer without network.
 */

import type {
  ClientMessage,
  ServerMessage,
} from "./agent-session-server-types.js";
import type { Connection, Transport } from "./transport.js";

export class InMemoryConnection implements Connection {
  private closeHandlers = new Set<() => void>();
  private messageHandlers = new Set<(message: ClientMessage) => void>();
  private messages: ClientMessage[] = [];
  private open = true;

  close(): void {
    this.open = false;
    this.closeHandlers.forEach((h) => h());
  }

  getReceivedMessages(): ServerMessage[] {
    return this.messages as unknown as ServerMessage[];
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onMessage(handler: (message: ClientMessage) => void): void {
    this.messageHandlers.add(handler);
    for (const msg of this.messages) {
      handler(msg);
    }
    this.messages = [];
  }

  send(message: ServerMessage): void {
    if (!this.open) return;
    this.messages.push(message as any);
  }

  simulateMessage(msg: ClientMessage): void {
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
