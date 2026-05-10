/**
 * AgentSessionClient - Client for connecting to AgentSessionServer.
 */

import type {
  SessionSnapshot,
  AgentSessionSyncEvent,
  SessionCommand,
  GlobalServerEvent,
} from "./agent-session-server-types.js";

export interface ClientTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: { type: string; [key: string]: any }): void;
  onMessage(handler: (message: any) => void): void;
  onClose(handler: () => void): void;
}

const GLOBAL_EVENT_TYPES = new Set([
  "server_connected",
  "server_shutdown",
  "session_created",
  "session_updated",
  "session_deleted",
  "session_status_changed",
  "resources_changed",
]);

export class AgentSessionClient {
  private readonly transport: ClientTransport;
  private connected = false;
  private readonly sessionCaches = new Map<string, SessionSnapshot>();
  private readonly sessionListeners = new Map<
    string,
    Set<(event: AgentSessionSyncEvent) => void>
  >();
  private readonly globalListeners = new Set<
    (event: GlobalServerEvent) => void
  >();

  constructor(transport: ClientTransport) {
    this.transport = transport;
    this.transport.onMessage((msg: any) => this.handleMessage(msg));
  }

  private handleMessage(msg: any): void {
    if (msg.type === "snapshot" && msg.sessionId) {
      this.sessionCaches.set(msg.sessionId, msg.data);
    }
    if (msg.type === "event" && msg.sessionId) {
      const listeners = this.sessionListeners.get(msg.sessionId);
      if (listeners) {
        for (const listener of listeners) {
          listener(msg.event);
        }
      }
    }
    if (GLOBAL_EVENT_TYPES.has(msg.type)) {
      for (const listener of this.globalListeners) {
        listener(msg);
      }
    }
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.connected = false;
  }

  async joinSession(sessionId: string): Promise<SessionSnapshot> {
    return new Promise((resolve) => {
      const handler = (msg: any) => {
        if (msg.type === "snapshot" && msg.sessionId === sessionId) {
          resolve(msg.data);
        }
      };
      this.transport.onMessage(handler);
      this.transport.send({ type: "join_session", sessionId });
    });
  }

  async command(sessionId: string, command: SessionCommand): Promise<void> {
    this.transport.send({ type: "command", sessionId, command });
  }

  subscribeSession(
    sessionId: string,
    listener: (event: AgentSessionSyncEvent) => void,
  ): () => void {
    if (!this.sessionListeners.has(sessionId)) {
      this.sessionListeners.set(sessionId, new Set());
    }
    this.sessionListeners.get(sessionId)!.add(listener);
    return () => {
      const listeners = this.sessionListeners.get(sessionId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.sessionListeners.delete(sessionId);
        }
      }
    };
  }

  subscribeGlobal(listener: (event: GlobalServerEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.sessionCaches.get(sessionId);
  }

  async listSessions(): Promise<any[]> {
    return new Promise((resolve) => {
      this.transport.onMessage((msg: any) => {
        if (msg.type === "session_list") {
          resolve(msg.sessions);
        }
      });
      this.transport.send({ type: "list_sessions" });
    });
  }

  async createSession(
    cwd: string,
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot }> {
    return new Promise((resolve) => {
      this.transport.onMessage((msg: any) => {
        if (msg.type === "snapshot" && msg.sessionId) {
          this.sessionCaches.set(msg.sessionId, msg.data);
          resolve({ sessionId: msg.sessionId, snapshot: msg.data });
        }
      });
      this.transport.send({ type: "create_session", cwd });
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.transport.send({ type: "delete_session", sessionId });
  }

  async leaveSession(sessionId: string): Promise<void> {
    this.transport.send({ type: "leave_session", sessionId });
  }
}
