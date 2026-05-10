/**
 * AgentSessionServer - Server that manages AgentSession instances and broadcasts events to clients.
 *
 * This class is transport-agnostic and uses interfaces for persistence and tool execution.
 */

import type { ThinkingLevel } from "@shiit/agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { SessionStore, SessionListItem } from "./session-store.js";
import type {
  SessionSnapshot,
  SessionFactory,
} from "./agent-session-server-types.js";
import type { Transport, Connection } from "./transport.js";
import type { ModelRegistry } from "./model-registry.js";
import type {
  AgentSessionSyncEvent,
  GlobalServerEvent,
  SessionCommand,
} from "./agent-session-server-types.js";

export class AgentSessionServer {
  private readonly _sessionStore: SessionStore;
  private readonly _sessionFactory: SessionFactory;
  private readonly _modelRegistry: ModelRegistry;
  private readonly _transport: Transport;

  private readonly _sessions: Map<string, SessionState> = new Map();
  private readonly _globalSubscribers: Set<(event: GlobalServerEvent) => void> =
    new Set();
  private _sequenceId = 0;
  private _running = false;

  constructor(
    sessionStore: SessionStore,
    sessionFactory: SessionFactory,
    modelRegistry: ModelRegistry,
    transport: Transport,
  ) {
    this._sessionStore = sessionStore;
    this._sessionFactory = sessionFactory;
    this._modelRegistry = modelRegistry;
    this._transport = transport;
  }

  getTransport(): Transport {
    return this._transport;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this._emitGlobal({ type: "server_connected" });
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;

    for (const [, state] of this._sessions) {
      state.session?.dispose();
    }
    this._sessions.clear();

    this._emitGlobal({ type: "server_shutdown" });
    await this._transport.close();
  }

  async createSession(
    cwd: string,
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot }> {
    const { sessionId } = await this._sessionStore.createSession(cwd);

    const session = await this._sessionFactory.createSession({
      sessionId,
      cwd,
    });

    const state: SessionState = {
      session,
      connections: new Set(),
      subscribers: new Set(),
    };
    this._sessions.set(sessionId, state);

    session.subscribe((event) => {
      for (const listener of state.subscribers) {
        listener(event as AgentSessionSyncEvent);
      }
    });

    const data = await this._sessionStore.getSession(sessionId);
    this._emitGlobal({
      type: "session_created",
      sessionId,
      info: data
        ? this._toListItem(data)
        : {
            id: sessionId,
            cwd,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
            messageCount: 0,
          },
    });

    const snapshot = await this._buildSnapshot(sessionId);
    return { sessionId, snapshot };
  }

  async joinSession(sessionId: string): Promise<SessionSnapshot> {
    let state = this._sessions.get(sessionId);
    if (!state) {
      const data = await this._sessionStore.getSession(sessionId);
      if (!data) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const session = await this._sessionFactory.createSession({
        sessionId,
        cwd: data.cwd,
      });

      const newState: SessionState = {
        session,
        connections: new Set(),
        subscribers: new Set(),
      };
      this._sessions.set(sessionId, newState);

      session.subscribe((event) => {
        for (const listener of newState.subscribers) {
          listener(event as AgentSessionSyncEvent);
        }
      });

      state = newState;
    }

    return await this._buildSnapshot(sessionId);
  }

  async leaveSession(sessionId: string): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (state) {
      state.session.dispose();
      await this._sessionFactory.closeSession(sessionId);
      this._sessions.delete(sessionId);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.leaveSession(sessionId);
    await this._sessionStore.deleteSession(sessionId);
    this._emitGlobal({ type: "session_deleted", sessionId });
  }

  async listSessions(): Promise<SessionListItem[]> {
    return this._sessionStore.listSessions();
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this._sessionStore.renameSession(sessionId, name);
    this._emitGlobal({ type: "session_renamed", sessionId, name });
  }

  async command(sessionId: string, cmd: SessionCommand): Promise<void> {
    let state = this._sessions.get(sessionId);
    if (!state) {
      await this.joinSession(sessionId);
      state = this._sessions.get(sessionId);
    }
    if (!state) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    switch (cmd.type) {
      case "prompt":
        await state.session.prompt(cmd.text);
        break;
      case "abort":
        state.session.abort();
        break;
      case "set_model": {
        const resolvedModel = this._modelRegistry.find(
          cmd.provider ?? "",
          cmd.modelId,
        );
        if (!resolvedModel) {
          throw new Error(`Model not found: ${cmd.provider}/${cmd.modelId}`);
        }
        await state.session.setModel(resolvedModel);
        break;
      }
      case "set_thinking_level":
        state.session.setThinkingLevel(cmd.level);
        break;
      case "set_tools":
        state.session.setActiveToolsByName(cmd.toolNames);
        break;
      case "navigate_tree":
        await state.session.navigateTree(cmd.leafId);
        break;
      case "compact":
        await state.session.compact(cmd.reason);
        break;
    }
  }

  subscribeSession(
    sessionId: string,
    listener: (event: AgentSessionSyncEvent) => void,
  ): () => void {
    const state = this._sessions.get(sessionId);
    if (!state) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    state.subscribers.add(listener);
    return () => {
      state.subscribers.delete(listener);
    };
  }

  subscribeGlobal(listener: (event: GlobalServerEvent) => void): () => void {
    this._globalSubscribers.add(listener);
    return () => {
      this._globalSubscribers.delete(listener);
    };
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this._sessions.get(sessionId)?.session;
  }

  private async _buildSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const storeData = await this._sessionStore.getSession(sessionId);
    const session = this._sessions.get(sessionId)?.session;

    return {
      sessionId,
      cwd: storeData?.cwd ?? session?.sessionManager?.getCwd() ?? "",
      leafId: storeData?.leafId ?? session?.sessionManager?.getLeafId() ?? null,
      branchEntries: storeData?.entries ?? [],
      thinkingLevel: session?.thinkingLevel ?? "medium",
      availableThinkingLevels: ["off", "low", "medium", "high"],
      activeToolNames: session?.getActiveToolNames() ?? [],
      queue: { steering: [], followUp: [] },
      agent: {
        isStreaming: session?.isStreaming ?? false,
        pendingToolCalls: [],
      },
      resources: {
        extensions: [],
        extensionErrors: [],
        skills: [],
        skillDiagnostics: [],
        prompts: [],
        promptDiagnostics: [],
        themes: [],
        themeDiagnostics: [],
      },
    };
  }

  private _emitGlobal(event: GlobalServerEvent): void {
    this._globalSubscribers.forEach((listener) => listener(event));
  }

  private _toListItem(data: any): SessionListItem {
    return {
      id: data.sessionId,
      name: data.name,
      cwd: data.cwd,
      createdAt: data.createdAt,
      modifiedAt: data.modifiedAt,
      messageCount: data.messages?.length ?? 0,
    };
  }
}

interface SessionState {
  session: AgentSession;
  connections: Set<Connection>;
  subscribers: Set<(event: AgentSessionSyncEvent) => void>;
}

export interface SessionHandle {
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: Model<any>;
  readonly thinkingLevel: ThinkingLevel;
  readonly isStreaming: boolean;
  readonly sessionName?: string;
  readonly leafId: string | null;
  readonly activeToolNames: readonly string[];

  prompt(text: string): Promise<void>;
  abort(): void;
  setModel(modelId: string, provider?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setActiveToolsByName(toolNames: string[]): void;
  navigateTree(leafId: string, label?: string): Promise<void>;
  compact(reason?: "manual" | "threshold" | "overflow"): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
  dispose(): void;
}
