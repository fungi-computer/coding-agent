import { beforeEach, describe, expect, test, vi } from "vitest";

import type { SessionFactory } from "../../src/core/agent-session-server-types.js";
import type { AgentSession } from "../../src/core/agent-session.js";

import { AgentSessionServer } from "../../src/core/agent-session-server.js";
import { InMemorySessionStore } from "../../src/core/in-memory-session-store.js";
import { InMemoryTransport } from "../../src/core/in-memory-transport.js";

const createMockSessionFactory = (
  session?: null | Partial<AgentSession>,
): SessionFactory => {
  const defaultSession: Partial<AgentSession> = {
    abort: vi.fn(),
    compact: vi.fn().mockResolvedValue(undefined),
    currentMessageId: undefined,
    dispose: vi.fn(),
    getActiveToolNames: vi.fn().mockReturnValue([]),
    getContextUsage: vi.fn().mockReturnValue(undefined),
    getSessionStats: vi.fn().mockReturnValue(undefined),
    isStreaming: false,
    navigateTree: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockResolvedValue(undefined),
    sessionId: "",
    sessionManager: {
      getBranch: vi.fn().mockReturnValue([]),
      getContextPath: vi.fn().mockReturnValue([]),
      getCwd: vi.fn().mockReturnValue("/tmp"),
      getEntries: vi.fn().mockReturnValue([]),
      getLeafId: vi.fn().mockReturnValue(null),
    } as any,
    setActiveToolsByName: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setThinkingLevel: vi.fn(),
    state: { isStreaming: false, streamingMessage: undefined } as any,
    subscribe: vi.fn().mockReturnValue(() => {}),
    thinkingLevel: "medium",
  };
  return {
    closeSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(session ?? defaultSession),
  };
};

const mockModelRegistry = {
  find: vi.fn(),
  hasConfiguredAuth: vi.fn().mockReturnValue(true),
} as unknown as import("../../src/core/model-registry.js").ModelRegistry;

describe("AgentSessionServer", () => {
  describe("session lifecycle", () => {
    test("createSession returns snapshot with sessionId", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const server = new AgentSessionServer(
        store,
        createMockSessionFactory(),
        mockModelRegistry,
        transport,
      );

      await server.start();
      const result = await server.createSession("/tmp");

      expect(result.sessionId).toBeDefined();
      expect(result.snapshot).toBeDefined();
      expect(result.snapshot.sessionId).toBe(result.sessionId);
      expect(result.snapshot.cwd).toBe("/tmp");

      await server.stop();
    });

    test("listSessions returns created session", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const server = new AgentSessionServer(
        store,
        createMockSessionFactory(),
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      const sessions = await server.listSessions();

      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe(sessionId);
      expect(sessions[0].cwd).toBe("/tmp");

      await server.stop();
    });
  });

  describe("lifecycle", () => {
    test("start emits server_connected event", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const server = new AgentSessionServer(
        store,
        createMockSessionFactory(),
        mockModelRegistry,
        transport,
      );

      const events: any[] = [];
      server.subscribeGlobal((e) => events.push(e));

      await server.start();

      expect(events).toContainEqual({ type: "server_connected" });

      await server.stop();
    });

    test("stop emits server_shutdown event", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const server = new AgentSessionServer(
        store,
        createMockSessionFactory(),
        mockModelRegistry,
        transport,
      );

      const events: any[] = [];
      server.subscribeGlobal((e) => events.push(e));

      await server.start();
      await server.stop();

      expect(events).toContainEqual({ type: "server_shutdown" });
    });
  });

  describe("transport integration", () => {
    test("server emits session_created global event when session created", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const server = new AgentSessionServer(
        store,
        createMockSessionFactory(),
        mockModelRegistry,
        transport,
      );

      const globalEvents: any[] = [];
      server.subscribeGlobal((e) => globalEvents.push(e));

      await server.start();
      await server.createSession("/tmp");

      const sessionCreated = globalEvents.find(
        (e) => e.type === "session_created",
      );
      expect(sessionCreated).toBeDefined();
      expect(sessionCreated.sessionId).toBeDefined();
      expect(sessionCreated.info.cwd).toBe("/tmp");

      await server.stop();
    });
  });

  describe("session cleanup", () => {
    test("leaveSession disposes session and calls factory.closeSession", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      await server.leaveSession(sessionId);

      expect(factory.closeSession).toHaveBeenCalledWith(sessionId);
      expect(factory.createSession({ cwd: "/tmp", sessionId })).toBeDefined();

      await server.stop();
    });

    test("deleteSession disposes session and deletes from store", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      await server.deleteSession(sessionId);

      expect(factory.closeSession).toHaveBeenCalledWith(sessionId);

      const sessions = await server.listSessions();
      expect(sessions.length).toBe(0);

      await server.stop();
    });
  });

  describe("command handling", () => {
    test("prompt command calls session.prompt", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId: "test",
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/tmp"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(() => {}),
      };
      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      await server.command(sessionId, { text: "Hello", type: "prompt" });

      expect(mockSession.prompt).toHaveBeenCalledWith("Hello");

      await server.stop();
    });

    test("set_thinking_level command calls session.setThinkingLevel", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId: "test",
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/tmp"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setThinkingLevel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(() => {}),
      };
      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      await server.command(sessionId, {
        level: "high",
        type: "set_thinking_level",
      });

      expect(mockSession.setThinkingLevel).toHaveBeenCalledWith("high");

      await server.stop();
    });

    test("command throws if session not found", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();

      await expect(
        server.command("nonexistent", { text: "hi", type: "prompt" }),
      ).rejects.toThrow("Session not found");

      await server.stop();
    });

    test("set_model command resolves model via ModelRegistry and calls session.setModel", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const mockModel = { id: "claude-3-5-sonnet", provider: "anthropic" };
      const mockModelRegistry = {
        find: vi.fn().mockReturnValue(mockModel),
      } as unknown as import("../../src/core/model-registry.js").ModelRegistry;
      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId: "test",
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/tmp"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        subscribe: vi.fn().mockReturnValue(() => {}),
      };
      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      await server.command(sessionId, {
        modelId: "claude-3-5-sonnet",
        provider: "anthropic",
        type: "set_model",
      });

      expect(mockModelRegistry.find).toHaveBeenCalledWith(
        "anthropic",
        "claude-3-5-sonnet",
      );
      expect(mockSession.setModel).toHaveBeenCalledWith(mockModel);

      await server.stop();
    });
  });

  describe("session event wiring", () => {
    test("session events are forwarded to subscribers", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();

      const mockSession = {
        _listener: undefined as ((event: any) => void) | undefined,
        abort: vi.fn(),
        activeToolNames: [] as string[],
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/tmp",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: null,
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId: "test-session",
        sessionName: undefined,
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/tmp"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn((listener: (event: any) => void) => {
          mockSession._listener = listener;
          return () => {
            mockSession._listener = undefined;
          };
        }),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");

      const sessionEvents: any[] = [];
      server.subscribeSession(sessionId, (e) => sessionEvents.push(e));

      mockSession._listener?.({
        model: undefined,
        previousModel: undefined,
        source: "set",
        type: "model_changed",
      });

      expect(sessionEvents.length).toBe(1);
      expect(sessionEvents[0].type).toBe("model_changed");

      await server.stop();
    });

    test("joinSession wires existing session and forwards events", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();

      const { sessionId } = await store.createSession("/test");

      const mockSession = {
        _listener: undefined as ((event: any) => void) | undefined,
        abort: vi.fn(),
        activeToolNames: [] as string[],
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/test",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: null,
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId,
        sessionName: undefined,
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/test"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn((listener: (event: any) => void) => {
          mockSession._listener = listener;
          return () => {
            mockSession._listener = undefined;
          };
        }),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      await server.joinSession(sessionId);

      const sessionEvents: any[] = [];
      server.subscribeSession(sessionId, (e) => sessionEvents.push(e));

      mockSession._listener?.({
        availableLevels: ["off", "low", "medium", "high"],
        level: "high",
        type: "thinking_level_changed",
      });

      expect(sessionEvents.length).toBe(1);
      expect(sessionEvents[0].type).toBe("thinking_level_changed");

      await server.stop();
    });

    // ARCH-136: REMOVED in plan-026 Phase 3. The transport-only
    // base64 strip was obsolete after Phase 1: `read_image`
    // returns a URL, so there is no base64 in the session to
    // strip. The behavior is now enforced by construction at
    // the tool level (read-image-url.test.ts in workspace).

    // ARCH-161: _buildSnapshot must use getContextPath() (bounded at the
    // most recent compaction), not getBranch() (full history). Otherwise
    // a session with one compaction and 1500+ post-compaction entries
    // produces a 3+ MB snapshot that OOMs the DO on WS upgrade.
    test("snapshot uses getContextPath, not getBranch", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();

      const { sessionId } = await store.createSession("/test");

      const preCompaction = {
        id: "pre-1",
        parentId: null,
        timestamp: "2026-07-04T00:00:00.000Z",
        type: "message" as const,
        message: {
          role: "user" as const,
          content: "this is the OLD pre-compaction message",
          timestamp: 1,
        },
      };
      const compactionEntry = {
        details: { modifiedFiles: [], readFiles: [] },
        firstKeptEntryId: "post-1",
        fromHook: false,
        id: "comp-1",
        parentId: "pre-1",
        summary: "summary of the pre-compaction era",
        timestamp: "2026-07-04T00:00:02.000Z",
        tokensBefore: 1000,
        type: "compaction" as const,
      };
      const postCompaction = {
        id: "post-1",
        parentId: "comp-1",
        timestamp: "2026-07-04T00:00:03.000Z",
        type: "message" as const,
        message: {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "this is the NEW post-compaction message",
            },
          ],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop" as const,
          timestamp: 4,
        },
      };

      // Full path includes the pre-compaction entry. Bounded path stops
      // at the compaction. The snapshot should be built from the bounded
      // path, not the full one.
      const fullPath = [preCompaction, compactionEntry, postCompaction];
      const boundedPath = [compactionEntry, postCompaction];

      const getBranch = vi.fn().mockReturnValue(fullPath);
      const getContextPath = vi.fn().mockReturnValue(boundedPath);

      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/test",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: "post-1",
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId,
        sessionName: undefined,
        sessionManager: {
          getBranch,
          getContextPath,
          getCwd: vi.fn().mockReturnValue("/test"),
          getEntries: vi.fn().mockReturnValue(fullPath),
          getLeafId: vi.fn().mockReturnValue("post-1"),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn().mockReturnValue(() => {}),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const snapshot = await server.joinSession(sessionId);

      // _buildSnapshot must call the bounded variant
      expect(getContextPath).toHaveBeenCalled();
      // The snapshot messages should reflect the bounded path
      const wireShape = JSON.stringify(snapshot.messages);
      expect(wireShape).toContain("this is the NEW post-compaction message");
      expect(wireShape).toContain("summary of the pre-compaction era");
      // The pre-compaction message must NOT appear in the snapshot
      expect(wireShape).not.toContain("this is the OLD pre-compaction message");

      await server.stop();
    });

    test("snapshot leaves non-image content untouched", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();

      const { sessionId } = await store.createSession("/test");

      const userEntry = {
        id: "entry-user",
        parentId: null,
        timestamp: "2026-07-04T00:00:00.000Z",
        type: "message" as const,
        message: {
          role: "user" as const,
          content: "hello world",
          timestamp: 1,
        },
      };
      const assistantEntry = {
        id: "entry-asst",
        parentId: "entry-user",
        timestamp: "2026-07-04T00:00:01.000Z",
        type: "message" as const,
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "hi there" }],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop" as const,
          timestamp: 2,
        },
      };

      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/test",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: null,
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId,
        sessionName: undefined,
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([userEntry, assistantEntry]),
          getContextPath: vi.fn().mockReturnValue([userEntry, assistantEntry]),
          getCwd: vi.fn().mockReturnValue("/test"),
          getEntries: vi.fn().mockReturnValue([userEntry, assistantEntry]),
          getLeafId: vi.fn().mockReturnValue("entry-asst"),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn().mockReturnValue(() => {}),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const snapshot = await server.joinSession(sessionId);

      const wireShape = JSON.stringify(snapshot.messages);
      expect(wireShape).toContain("hello world");
      expect(wireShape).toContain("hi there");

      await server.stop();
    });
  });
  describe("snapshot message limit", () => {
    function buildMessageEntries(count: number) {
      const entries = [];
      let prevId: string | null = null;
      for (let i = 0; i < count; i++) {
        const id = `msg-${i}`;
        entries.push({
          id,
          parentId: prevId,
          timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          type: "message" as const,
          message: {
            role: "user" as const,
            content: `message ${i}`,
            timestamp: i,
          },
        });
        prevId = id;
      }
      return entries;
    }

    test("snapshot with more than 50 messages is capped to the last 50 and hasMoreMessages is true", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const { sessionId } = await store.createSession("/test");

      const entries = buildMessageEntries(60);

      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/test",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: "msg-59",
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId,
        sessionName: undefined,
        sessionManager: {
          getBranch: vi.fn().mockReturnValue(entries),
          getContextPath: vi.fn().mockReturnValue(entries),
          getCwd: vi.fn().mockReturnValue("/test"),
          getEntries: vi.fn().mockReturnValue(entries),
          getLeafId: vi.fn().mockReturnValue("msg-59"),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn().mockReturnValue(() => {}),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const snapshot = await server.joinSession(sessionId);

      expect(snapshot.messages.length).toBe(50);
      expect(snapshot.hasMoreMessages).toBe(true);
      expect((snapshot.messages[0] as any).content).toBe("message 10");

      await server.stop();
    });

    test("snapshot with 50 or fewer messages includes all and hasMoreMessages is false", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const { sessionId } = await store.createSession("/test");

      const entries = buildMessageEntries(30);

      const mockSession = {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        currentMessageId: undefined,
        cwd: "/test",
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isStreaming: false,
        leafId: "msg-29",
        model: undefined,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId,
        sessionName: undefined,
        sessionManager: {
          getBranch: vi.fn().mockReturnValue(entries),
          getContextPath: vi.fn().mockReturnValue(entries),
          getCwd: vi.fn().mockReturnValue("/test"),
          getEntries: vi.fn().mockReturnValue(entries),
          getLeafId: vi.fn().mockReturnValue("msg-29"),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined } as any,
        subscribe: vi.fn().mockReturnValue(() => {}),
        thinkingLevel: "medium" as const,
      };

      const factory = createMockSessionFactory(
        mockSession as unknown as AgentSession,
      );
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const snapshot = await server.joinSession(sessionId);

      expect(snapshot.messages.length).toBe(30);
      expect(snapshot.hasMoreMessages).toBe(false);
      expect((snapshot.messages[0] as any).content).toBe("message 0");
      expect((snapshot.messages[29] as any).content).toBe("message 29");

      await server.stop();
    });
  });

  describe("session load discipline", () => {
    test("command on an evicted session reloads and runs", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");
      await server.leaveSession(sessionId);
      expect(server.getSession(sessionId)).toBeUndefined();

      await server.command(sessionId, { text: "Hello", type: "prompt" });
      expect(server.getSession(sessionId)).toBeDefined();
      await server.stop();
    });

    test("session with a subscriber is never evicted", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");
      const unsub = server.subscribeSession(sessionId, () => undefined);

      // Force a capacity eviction attempt by joining another session.
      const { sessionId: otherId } = await store.createSession("/other");
      await server.joinSession(otherId);

      expect(server.getSession(sessionId)).toBeDefined();
      unsub();
      await server.stop();
    });

    test("running session is never evicted", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId: runningId } = await server.createSession("/tmp");
      const runningState = (server as any)._sessions.get(runningId);
      runningState.session.isStreaming = true;

      const { sessionId: otherId } = await store.createSession("/other");
      await server.joinSession(otherId);

      expect(server.getSession(runningId)).toBeDefined();
      await server.stop();
    });

    test("idle+unwatched+not-running session is evicted on the next load sweep", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");
      const state = (server as any)._sessions.get(sessionId);
      state.lastActivityAt = Date.now() - 11 * 60 * 1000;

      const { sessionId: otherId } = await store.createSession("/other");
      await server.joinSession(otherId);

      expect(server.getSession(sessionId)).toBeUndefined();
      await server.stop();
    });

    test("soft cap: loading a 4th session evicts the LRU eligible one; an all-ineligible set exceeds the cap without evicting", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const a = await store.createSession("/a");
      const b = await store.createSession("/b");
      const c = await store.createSession("/c");
      const d = await store.createSession("/d");

      await server.joinSession(a.sessionId);
      await server.joinSession(b.sessionId);
      await server.joinSession(c.sessionId);
      expect((server as any)._sessions.size).toBe(3);

      // Mark A LRU by backdating it; B/C remain eligible but newer.
      const aState = (server as any)._sessions.get(a.sessionId);
      aState.lastActivityAt = Date.now() - 60_000;

      await server.joinSession(d.sessionId);
      expect(server.getSession(a.sessionId)).toBeUndefined();
      expect(server.getSession(d.sessionId)).toBeDefined();

      // Make B watched (subscriber) and C streaming; load A back.
      // Cap is exceeded, but D is the only eligible session and should
      // remain because we never evict ineligible sessions.
      server.subscribeSession(b.sessionId, () => undefined);
      const cState = (server as any)._sessions.get(c.sessionId);
      cState.session.isStreaming = true;

      await server.joinSession(a.sessionId);
      expect(server.getSession(a.sessionId)).toBeDefined();
      expect(server.getSession(b.sessionId)).toBeDefined();
      expect(server.getSession(c.sessionId)).toBeDefined();
      expect(server.getSession(d.sessionId)).toBeDefined();
      expect((server as any)._sessions.size).toBe(4);

      await server.stop();
    });

    test("detach drives unsubscribe so the session becomes evictable", async () => {
      const transport = new InMemoryTransport();
      const store = new InMemorySessionStore();
      const factory = createMockSessionFactory();
      const server = new AgentSessionServer(
        store,
        factory,
        mockModelRegistry,
        transport,
      );

      await server.start();
      const { sessionId } = await server.createSession("/tmp");
      const unsub = server.subscribeSession(sessionId, () => undefined);
      expect((server as any)._sessions.get(sessionId).subscribers.size).toBe(1);
      unsub();
      expect((server as any)._sessions.get(sessionId).subscribers.size).toBe(0);

      await server.stop();
    });
  });

  describe("agent turn system", () => {
    function deferred<T = void>(): {
      promise: Promise<T>;
      reject: (reason?: unknown) => void;
      resolve: (value: T) => void;
    } {
      let resolve: any;
      let reject: any;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, reject, resolve };
    }

    function makeMockSession(overrides: Partial<any> = {}): any {
      return {
        abort: vi.fn(),
        compact: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        getActiveToolNames: vi.fn().mockReturnValue([]),
        getContextUsage: vi.fn().mockReturnValue(undefined),
        getSessionStats: vi.fn().mockReturnValue(undefined),
        isCompacting: false,
        isStreaming: false,
        navigateTree: vi.fn().mockResolvedValue(undefined),
        prompt: vi.fn().mockResolvedValue(undefined),
        sessionId: "",
        sessionManager: {
          getBranch: vi.fn().mockReturnValue([]),
          getContextPath: vi.fn().mockReturnValue([]),
          getCwd: vi.fn().mockReturnValue("/tmp"),
          getEntries: vi.fn().mockReturnValue([]),
          getLeafId: vi.fn().mockReturnValue(null),
        },
        setActiveToolsByName: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        setThinkingLevel: vi.fn(),
        state: { isStreaming: false, streamingMessage: undefined },
        subscribe: vi.fn().mockReturnValue(() => {}),
        thinkingLevel: "medium",
        ...overrides,
      };
    }

    function createStatefulFactory(): {
      factory: any;
      sessions: Map<string, any>;
    } {
      const sessions = new Map<string, any>();
      const factory = createMockSessionFactory();
      factory.createSession = vi.fn(async ({ sessionId }: any) => {
        if (sessions.has(sessionId)) return sessions.get(sessionId);
        const s = makeMockSession();
        s.sessionId = sessionId;
        sessions.set(sessionId, s);
        return s;
      });
      return { factory, sessions };
    }

    test("B prompts while A runs → B is queued and A stays active", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;

      const aRun = deferred();
      a.prompt = vi.fn(() => aRun.promise);

      const bEvents: any[] = [];
      server.subscribeSession(bId, (e) => bEvents.push(e));

      const aCommand = server.command(aId, { text: "run A", type: "prompt" });
      await server.command(bId, { text: "run B", type: "prompt" });

      expect(bEvents).toContainEqual({
        position: 0,
        sessionId: bId,
        type: "queued",
      });
      expect((server as any)._activeSessionId).toBe(aId);
      expect(a.prompt).toHaveBeenCalledWith("run A");
      expect(b.prompt).not.toHaveBeenCalled();

      aRun.resolve();
      await aCommand;
      await server.stop();
    });

    test("A ends → Bs turn starts and followUps replay", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;

      const aRun = deferred();
      a.prompt = vi.fn(() => aRun.promise);

      server.command(aId, { text: "A", type: "prompt" });
      await server.command(bId, { text: "B-1", type: "prompt" });
      await server.command(bId, { text: "B-2", type: "prompt" });

      expect((server as any)._turnQueue.length).toBe(1);
      expect((server as any)._turnQueue[0].followUps).toEqual(["B-2"]);

      aRun.resolve();
      await new Promise((r) => setTimeout(r, 0));

      expect(b.prompt).toHaveBeenNthCalledWith(1, "B-1");
      expect(b.prompt).toHaveBeenNthCalledWith(2, "B-2");
      expect((server as any)._turnQueue.length).toBe(0);

      await server.stop();
    });

    test("second prompt for queued session appends followUp, no new queue entry", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      a.prompt = vi.fn(() => deferred().promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B-1", type: "prompt" });
      await server.command(bId, { text: "B-2", type: "prompt" });

      expect((server as any)._turnQueue.length).toBe(1);
      expect((server as any)._turnQueue[0].followUps).toEqual(["B-2"]);

      await server.stop();
    });

    test("interactive lane runs before cron lane", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const { sessionId: cId } = await server.createSession("/c");
      const a = sessions.get(aId)!;
      a.prompt = vi.fn(() => deferred().promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, {
        lane: "cron",
        text: "cron-B",
        type: "prompt",
      });
      await server.command(cId, { text: "interactive-C", type: "prompt" });

      const queue = (server as any)._turnQueue;
      expect(queue.map((e: any) => e.sessionId)).toEqual([cId, bId]);

      await server.stop();
    });

    test("abort on queued session dequeues it and updates positions", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const { sessionId: cId } = await server.createSession("/c");
      const a = sessions.get(aId)!;
      a.prompt = vi.fn(() => deferred().promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B", type: "prompt" });
      await server.command(cId, { text: "C", type: "prompt" });

      const cEvents: any[] = [];
      server.subscribeSession(cId, (e) => cEvents.push(e));

      await server.command(bId, { type: "abort" });

      expect((server as any)._turnQueue.map((e: any) => e.sessionId)).toEqual([
        cId,
      ]);
      expect(cEvents).toContainEqual({
        position: 0,
        sessionId: cId,
        type: "queued",
      });

      await server.stop();
    });

    test("abort on active session stops run and advances queue", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;

      const aRun = deferred();
      a.prompt = vi.fn(() => aRun.promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B", type: "prompt" });

      await server.command(aId, { type: "abort" });
      aRun.resolve();
      await new Promise((r) => setTimeout(r, 0));

      expect(a.abort).toHaveBeenCalled();
      expect(b.prompt).toHaveBeenCalledWith("B");

      await server.stop();
    });

    test("A's run error releases slot and starts Bs turn (wedge regression)", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;

      const aRun = deferred<void>();
      a.prompt = vi.fn(() => aRun.promise);

      const aCommand = server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B", type: "prompt" });

      aRun.reject(new Error("upstream timeout"));
      await expect(aCommand).rejects.toThrow("upstream timeout");
      await new Promise((r) => setTimeout(r, 0));

      expect(b.prompt).toHaveBeenCalledWith("B");

      await server.stop();
    });

    test("pass-through commands on queued session execute immediately", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;
      a.prompt = vi.fn(() => deferred().promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B", type: "prompt" });
      await server.command(bId, { leafId: "leaf-1", type: "navigate_tree" });

      expect(b.navigateTree).toHaveBeenCalledWith("leaf-1");
      expect((server as any)._turnQueue.length).toBe(1);

      await server.stop();
    });

    test("new server has empty queue", async () => {
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        createMockSessionFactory(),
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      expect((server as any)._turnQueue).toEqual([]);
      expect((server as any)._activeSessionId).toBeNull();
      await server.stop();
    });

    test("evicting queued session drops it without affecting active slot", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();
      const { sessionId: aId } = await server.createSession("/a");
      const { sessionId: bId } = await server.createSession("/b");
      const a = sessions.get(aId)!;
      const b = sessions.get(bId)!;
      a.prompt = vi.fn(() => deferred().promise);

      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));
      await server.command(bId, { text: "B", type: "prompt" });

      (server as any)._evictSession(bId);

      expect((server as any)._turnQueue.length).toBe(0);
      expect((server as any)._activeSessionId).toBe(aId);
      expect(b.prompt).not.toHaveBeenCalled();

      await server.stop();
    });

    test("followUps cap and global queue cap emit error frames", async () => {
      const { factory, sessions } = createStatefulFactory();
      const server = new AgentSessionServer(
        new InMemorySessionStore(),
        factory,
        mockModelRegistry,
        new InMemoryTransport(),
      );
      await server.start();

      // A holds the active slot with a never-resolving run.
      const { sessionId: aId } = await server.createSession("/a");
      const a = sessions.get(aId)!;
      a.prompt = vi.fn(() => deferred().promise);
      server.command(aId, { text: "A", type: "prompt" });
      await new Promise((r) => setTimeout(r, 0));

      // B is queued. The first prompt creates the queue entry; the next 20
      // become followUps. The 22nd prompt for B exceeds the followUps cap.
      const { sessionId: bId } = await server.createSession("/b");
      server.subscribeSession(bId, () => undefined);
      for (let i = 0; i < 21; i++) {
        await server.command(bId, { text: `B-${i}`, type: "prompt" });
      }

      const bEvents: any[] = [];
      server.subscribeSession(bId, (e) => bEvents.push(e));
      await server.command(bId, { text: "B-overflow", type: "prompt" });

      expect(bEvents).toContainEqual({
        kind: "followups_full",
        terminal: false,
        type: "error",
      });

      // Fill the global queue to 16 entries using separate, watched sessions.
      const unsubs: (() => void)[] = [];
      for (let i = 0; i < 15; i++) {
        const { sessionId } = await server.createSession(`/fill-${i}`);
        unsubs.push(server.subscribeSession(sessionId, () => undefined));
        await server.command(sessionId, {
          text: `fill-${i}`,
          type: "prompt",
        });
      }

      const lastEvents: any[] = [];
      const { sessionId: lastId } = await server.createSession("/last");
      unsubs.push(server.subscribeSession(lastId, () => undefined));
      server.subscribeSession(lastId, (e) => lastEvents.push(e));
      await server.command(lastId, { text: "too many", type: "prompt" });

      expect(lastEvents).toContainEqual({
        kind: "queue_full",
        terminal: false,
        type: "error",
      });

      for (const unsub of unsubs) unsub();
      await server.stop();
    });
  });
});
