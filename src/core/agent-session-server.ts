/**
 * AgentSessionServer - Server that manages AgentSession instances and broadcasts events to clients.
 *
 * This class is transport-agnostic and uses interfaces for persistence and tool execution.
 */

import type { Model } from "@earendil-works/pi-ai";
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
import { buildSessionContext } from "./session-manager.js";
import {
  deriveAgentRuntimeStatus,
  type AgentRuntimeStatus,
} from "./agent-session-status.js";
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

/**
 * Max messages included in a WebSocket snapshot. Older history
 * backfills over HTTP.
 */
const SNAPSHOT_MESSAGE_LIMIT = 50;

export class AgentSessionServer {
  private readonly _globalSubscribers = new Set<
    (event: GlobalServerEvent) => void
  >();
  private readonly _modelRegistry: ModelRegistry;
  private _running = false;
  private _sequenceId = 0;

  private readonly _sessionFactory: SessionFactory;
  private readonly _sessions = new Map<string, SessionState>();
  private readonly _joinInflight = new Map<string, Promise<void>>();
  private readonly _sessionStatuses = new Map<string, AgentRuntimeStatus>();
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
    // PLAN-028: single-flight the cold load. Concurrent attaches of
    // the same session (two tabs, a reconnect racing a hibernation
    // wake) previously each ran the full factory rebuild — the
    // duplicate `creating_session` interleaves in production logs.
    // The second caller now awaits the first's result.
    if (!this._sessions.has(sessionId)) {
      const inflight = this._joinInflight.get(sessionId);
      if (inflight) {
        await inflight;
      } else {
        const load = this.loadSession(sessionId);
        this._joinInflight.set(sessionId, load);
        try {
          await load;
        } finally {
          this._joinInflight.delete(sessionId);
        }
      }
    }
    return await this._buildSnapshot(sessionId, SNAPSHOT_MESSAGE_LIMIT);
  }

  /**
   * Full-history snapshot for the HTTP snapshot endpoint. Same
   * single-flight load as `joinSession`, but no message cap — the
   * dashboard's backfill relies on this returning everything.
   */
  async getFullSnapshot(sessionId: string): Promise<SessionSnapshot> {
    if (!this._sessions.has(sessionId)) {
      const inflight = this._joinInflight.get(sessionId);
      if (inflight) {
        await inflight;
      } else {
        const load = this.loadSession(sessionId);
        this._joinInflight.set(sessionId, load);
        try {
          await load;
        } finally {
          this._joinInflight.delete(sessionId);
        }
      }
    }
    return await this._buildSnapshot(sessionId);
  }

  private async loadSession(sessionId: string): Promise<void> {
    if (this._sessions.has(sessionId)) return;
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
      this._updateSessionStatus(sessionId, event as AgentSessionSyncEvent);
    });

    console.log(
      `[loadSession] sessionId=${sessionId} loadedSessions=${this._sessions.size}`,
    );

    this._emitSessionStatus(sessionId);
    this._emitGlobal({ sessionId, type: "session_loaded" });
  }

  async leaveSession(sessionId: string): Promise<void> {
    const state = this._sessions.get(sessionId);
    if (state) {
      this._emitGlobal({ sessionId, type: "session_unloaded" });
      this._sessionStatuses.delete(sessionId);
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

  /**
   * Compute the current runtime status of a loaded session.
   * Mirrors the logic in `_buildSnapshot`.
   */
  private _computeSessionStatus(sessionId: string): AgentRuntimeStatus {
    const session = this._sessions.get(sessionId)?.session;
    if (session?.isCompacting) return "compacting";
    if (session?.isStreaming) {
      return session.state.streamingMessage != null ? "streaming" : "thinking";
    }
    return "idle";
  }

  private _emitSessionStatus(sessionId: string): void {
    const status = this._computeSessionStatus(sessionId);
    this._sessionStatuses.set(sessionId, status);
    this._emitGlobal({ sessionId, status, type: "session_status_changed" });
  }

  private _updateSessionStatus(
    sessionId: string,
    event: AgentSessionSyncEvent,
  ): void {
    const next = deriveAgentRuntimeStatus(event);
    if (!next) return;
    const prev = this._sessionStatuses.get(sessionId);
    if (prev === next) return;
    this._sessionStatuses.set(sessionId, next);
    this._emitGlobal({
      sessionId,
      status: next,
      type: "session_status_changed",
    });
  }

  private async _buildSnapshot(
    sessionId: string,
    messageLimit?: number,
  ): Promise<SessionSnapshot> {
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

    const allMessages = buildSessionContext(
      manager?.getContextPath() ?? [],
      manager?.getLeafId() ?? undefined,
    ).messages;
    const hasMoreMessages =
      messageLimit !== undefined && allMessages.length > messageLimit;
    const messages =
      messageLimit !== undefined
        ? allMessages.slice(-messageLimit)
        : allMessages;
    // PLAN-028 diagnostics: the OOM investigation. Log what the
    // snapshot actually holds (count, capped count, serialized size)
    // plus how many sessions this DO currently has loaded.
    const serialized = JSON.stringify(messages);
    console.log(
      `[_buildSnapshot] sessionId=${sessionId} allMessages=${allMessages.length} capped=${messages.length} jsonBytes=${serialized.length} loadedSessions=${this._sessions.size}`,
    );

    return {
      activeToolNames: session?.getActiveToolNames() ?? [],
      agent: {
        currentMessage: session?.state?.streamingMessage,
        currentMessageId: session?.currentMessageId,
        isStreaming: session?.isStreaming ?? false,
        pendingToolCalls: [],
      },
      availableThinkingLevels: ["off", "low", "medium", "high"],
      contextUsage: session?.getContextUsage(),
      cost: session?.getSessionStats()?.cost,
      status,
      cwd: manager?.getCwd() ?? "",
      hasMoreMessages,
      leafId: manager?.getLeafId() ?? null,
      messages,
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

// plan-026 Phase 3: `stripImagesForTransport` removed. The
// transport-only strip was obsolete by construction after
// Phase 1 landed: `read_image` now returns a URL, so there is
// no base64 in the session to strip. Snapshots are bounded by
// the absence of base64, not by post-hoc filtering.
