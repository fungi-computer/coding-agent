/**
 * AgentSessionServer - Server that manages AgentSession instances and broadcasts events to clients.
 *
 * This class is transport-agnostic and uses interfaces for persistence and tool execution.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@shiit/agent-core";

import type {
  SessionFactory,
  SessionSnapshot,
} from "./agent-session-server-types.js";
import type {
  AgentSessionSyncEvent,
  GlobalServerEvent,
  SessionCommand,
} from "./agent-session-server-types.js";
import type { AgentSession } from "./agent-session.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SessionListItem, SessionStore } from "./session-store.js";
import type { Connection, Transport } from "./transport.js";

export interface SessionHandle {
  abort(): void;
  readonly activeToolNames: readonly string[];
  compact(reason?: "manual" | "overflow" | "threshold"): Promise<void>;
  readonly cwd: string;
  dispose(): void;
  readonly isStreaming: boolean;
  readonly leafId: null | string;
  readonly model?: Model<any>;

  navigateTree(leafId: string, label?: string): Promise<void>;
  prompt(text: string): Promise<void>;
  readonly sessionId: string;
  readonly sessionName?: string;
  setActiveToolsByName(toolNames: string[]): void;
  setModel(modelId: string, provider?: string): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  subscribe(listener: (event: any) => void): () => void;
  readonly thinkingLevel: ThinkingLevel;
}

interface SessionState {
  connections: Set<Connection>;
  session: AgentSession;
  subscribers: Set<(event: AgentSessionSyncEvent) => void>;
}

export class AgentSessionServer {
  private readonly _globalSubscribers = new Set<
    (event: GlobalServerEvent) => void
  >();
  private readonly _modelRegistry: ModelRegistry;
  private _running = false;
  private _sequenceId = 0;

  private readonly _sessionFactory: SessionFactory;
  private readonly _sessions = new Map<string, SessionState>();
  private readonly _sessionStore: SessionStore;
  private readonly _transport: Transport;

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
      case "abort":
        state.session.abort();
        break;
      case "compact":
        await state.session.compact(cmd.reason);
        break;
      case "navigate_tree":
        await state.session.navigateTree(cmd.leafId);
        break;
      case "prompt":
        await state.session.prompt(cmd.text);
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
    }
  }

  async createSession(
    cwd: string,
  ): Promise<{ sessionId: string; snapshot: SessionSnapshot }> {
    const { sessionId } = await this._sessionStore.createSession(cwd);

    const session = await this._sessionFactory.createSession({
      cwd,
      sessionId,
    });

    const state: SessionState = {
      connections: new Set(),
      session,
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
      info: data
        ? this._toListItem(data)
        : {
            createdAt: Date.now(),
            cwd,
            id: sessionId,
            messageCount: 0,
            modifiedAt: Date.now(),
          },
      sessionId,
      type: "session_created",
    });

    const snapshot = await this._buildSnapshot(sessionId);
    return { sessionId, snapshot };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.leaveSession(sessionId);
    await this._sessionStore.deleteSession(sessionId);
    this._emitGlobal({ sessionId, type: "session_deleted" });
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this._sessions.get(sessionId)?.session;
  }

  getTransport(): Transport {
    return this._transport;
  }

  async joinSession(sessionId: string): Promise<SessionSnapshot> {
    let state = this._sessions.get(sessionId);
    if (!state) {
      const data = await this._sessionStore.getSession(sessionId);
      if (!data) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const session = await this._sessionFactory.createSession({
        cwd: data.cwd,
        sessionId,
      });

      const newState: SessionState = {
        connections: new Set(),
        session,
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

  async listSessions(): Promise<SessionListItem[]> {
    return this._sessionStore.listSessions();
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this._sessionStore.renameSession(sessionId, name);
    this._emitGlobal({ name, sessionId, type: "session_renamed" });
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

  subscribeGlobal(listener: (event: GlobalServerEvent) => void): () => void {
    this._globalSubscribers.add(listener);
    return () => {
      this._globalSubscribers.delete(listener);
    };
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

  private async _buildSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this._sessions.get(sessionId)?.session;
    const manager = session?.sessionManager;

    let status: "idle" | "thinking" | "streaming" | "compacting" = "idle";
    if (session?.isCompacting) {
      status = "compacting";
    } else if (session?.isStreaming) {
      status =
        session.state.streamingMessage != null ? "streaming" : "thinking";
    }

    const resourceLoader = session?.resourceLoader;
    const skillsResult = resourceLoader?.getSkills();
    console.log(
      `[_buildSnapshot] sessionId=${sessionId} hasSession=${!!session} hasResourceLoader=${!!resourceLoader} skillsCount=${skillsResult?.skills.length ?? -1}`,
    );
    const promptsResult = resourceLoader?.getPrompts();
    const themesResult = resourceLoader?.getThemes();
    const extensionsResult = resourceLoader?.getExtensions();

    return {
      activeToolNames: session?.getActiveToolNames() ?? [],
      agent: {
        currentMessage: session?.state?.streamingMessage,
        currentMessageId: session?.currentMessageId,
        isStreaming: session?.isStreaming ?? false,
        pendingToolCalls: [],
      },
      availableThinkingLevels: ["off", "low", "medium", "high"],
      branchEntries: manager?.getEntries() ?? [],
      contextUsage: session?.getContextUsage(),
      cost: session?.getSessionStats()?.cost,
      status,
      cwd: manager?.getCwd() ?? "",
      leafId: manager?.getLeafId() ?? null,
      model: session?.model,
      queue: { followUp: [], steering: [] },
      resources: {
        extensionErrors: extensionsResult?.errors ?? [],
        extensions:
          extensionsResult?.extensions.map((e) => ({
            path: e.path,
            sourceInfo: e.sourceInfo,
          })) ?? [],
        promptDiagnostics: promptsResult?.diagnostics ?? [],
        prompts:
          promptsResult?.prompts.map((p) => ({
            filePath: p.filePath,
            name: p.name,
            sourceInfo: p.sourceInfo,
          })) ?? [],
        skillDiagnostics: skillsResult?.diagnostics ?? [],
        skills:
          skillsResult?.skills.map((s) => ({
            filePath: s.filePath,
            name: s.name,
            sourceInfo: s.sourceInfo,
          })) ?? [],
        themeDiagnostics: themesResult?.diagnostics ?? [],
        themes: themesResult?.themes ?? [],
      },
      sessionId,
      thinkingLevel: session?.thinkingLevel ?? "medium",
    };
  }

  private _emitGlobal(event: GlobalServerEvent): void {
    this._globalSubscribers.forEach((listener) => listener(event));
  }

  private _toListItem(data: any): SessionListItem {
    return {
      createdAt: data.createdAt,
      cwd: data.cwd,
      id: data.sessionId,
      messageCount: data.messages?.length ?? 0,
      modifiedAt: data.modifiedAt,
      name: data.name,
    };
  }
}
