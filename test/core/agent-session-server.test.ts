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
};

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
      };
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
});
