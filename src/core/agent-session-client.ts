/**
 * AgentSessionClient - Client for connecting to AgentSessionServer.
 */

import type {
  AgentSessionSyncEvent,
  GlobalServerEvent,
  SessionCommand,
  SessionSnapshot,
} from "./agent-session-server-types.js";

export interface ClientTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onClose(handler: () => void): void;
  onMessage(handler: (message: any) => void): void;
  send(message: { [key: string]: any; type: string }): void;
}

const GLOBAL_EVENT_TYPES = new Set([
  "resources_changed",
  "server_connected",
  "server_shutdown",
  "session_created",
  "session_deleted",
  "session_status_changed",
  "session_updated",
]);

export class AgentSessionClient {
  private connected = false;
  private readonly globalListeners = new Set<
    (event: GlobalServerEvent) => void
  >();
  private readonly sessionCaches = new Map<string, SessionSnapshot>();
  private readonly sessionListeners = new Map<
    string,
    Set<(event: AgentSessionSyncEvent) => void>
  >();
  private readonly transport: ClientTransport;

  constructor(transport: ClientTransport) {
    this.transport = transport;
    this.transport.onMessage((msg: any) => this.handleMessage(msg));
  }

  async command(sessionId: string, command: SessionCommand): Promise<void> {
    this.transport.send({ command, sessionId, type: "command" });
  }

  async connect(): Promise<void> {
    await this.transport.connect();
    this.connected = true;
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
      this.transport.send({ cwd, type: "create_session" });
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.transport.send({ sessionId, type: "delete_session" });
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this.connected = false;
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.sessionCaches.get(sessionId);
  }

  async joinSession(sessionId: string): Promise<SessionSnapshot> {
    return new Promise((resolve) => {
      const handler = (msg: any) => {
        if (msg.type === "snapshot" && msg.sessionId === sessionId) {
          resolve(msg.data);
        }
      };
      this.transport.onMessage(handler);
      this.transport.send({ sessionId, type: "join_session" });
    });
  }

  async leaveSession(sessionId: string): Promise<void> {
    this.transport.send({ sessionId, type: "leave_session" });
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

  subscribeGlobal(listener: (event: GlobalServerEvent) => void): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
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
}
