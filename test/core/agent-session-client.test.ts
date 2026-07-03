import { describe, expect, test, vi } from "vitest";

import { AgentSessionClient } from "../../src/core/agent-session-client.js";

const createTransport = () => {
  const handlers = new Set<(msg: any) => void>();

  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    handlers,
    onClose: vi.fn(),
    onMessage: vi.fn((handler: (msg: any) => void) => {
      handlers.add(handler);
    }),
    send: vi.fn(),
    simulateMessage: (msg: any) => {
      for (const handler of handlers) {
        handler(msg);
      }
    },
  };
};

const testSnapshot = (overrides?: { cwd?: string; sessionId?: string }) => ({
  activeToolNames: ["read", "bash"] as const,
  agent: { isStreaming: false, pendingToolCalls: [] },
  availableThinkingLevels: ["off", "low", "medium", "high"] as const,
  cwd: overrides?.cwd ?? "/",
  leafId: "leaf-1",
  messages: [],
  queue: { followUp: [] as const, steering: [] as const },
  resources: {
    extensionErrors: [],
    extensions: [],
    promptDiagnostics: [],
    prompts: [],
    skillDiagnostics: [],
    skills: [],
    themeDiagnostics: [],
    themes: [],
  },
  sessionId: overrides?.sessionId ?? "test-session",
  thinkingLevel: "medium" as const,
});

describe("AgentSessionClient", () => {
  describe("connect and disconnect", () => {
    test("connect establishes connection", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      expect(transport.connect).toHaveBeenCalled();
    });
  });

  describe("joinSession", () => {
    test("joinSession returns snapshot from server", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const joinPromise = client.joinSession("test-session");
      transport.simulateMessage({
        data: testSnapshot({ sessionId: "test-session" }),
        sessionId: "test-session",
        type: "snapshot",
      });

      const snapshot = await joinPromise;
      expect(snapshot.sessionId).toBe("test-session");
    });

    test("after join, snapshot is cached", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      // Start join but DON'T await - message comes after
      const joinPromise = client.joinSession("test-session");
      transport.simulateMessage({
        data: testSnapshot({ cwd: "/home", sessionId: "test-session" }),
        sessionId: "test-session",
        type: "snapshot",
      });
      await joinPromise;

      const cached = client.getSnapshot("test-session");
      expect(cached?.cwd).toBe("/home");
    });
  });

  describe("getSnapshot", () => {
    test("returns undefined for unknown session", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const cached = client.getSnapshot("unknown");
      expect(cached).toBeUndefined();
    });
  });

  describe("command", () => {
    test("after joining, commands can be sent", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      // Join first (don't await, message comes after)
      const joinPromise = client.joinSession("test-session");
      transport.simulateMessage({
        data: testSnapshot(),
        sessionId: "test-session",
        type: "snapshot",
      });
      await joinPromise;

      // Send command
      await client.command("test-session", { text: "hello", type: "prompt" });

      expect(transport.send).toHaveBeenCalledWith({
        command: { text: "hello", type: "prompt" },
        sessionId: "test-session",
        type: "command",
      });
    });
  });

  describe("subscribeSession", () => {
    test("receives events after joining session", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      // Join session (don't await, message comes after)
      const joinPromise = client.joinSession("test-session");
      transport.simulateMessage({
        data: testSnapshot(),
        sessionId: "test-session",
        type: "snapshot",
      });
      await joinPromise;

      // Subscribe to events
      const received: any[] = [];
      client.subscribeSession("test-session", (e) => received.push(e));

      // Receive events
      transport.simulateMessage({
        event: { type: "agent_start" },
        sessionId: "test-session",
        type: "event",
      });
      transport.simulateMessage({
        event: { turnIndex: 0, type: "turn_start" },
        sessionId: "test-session",
        type: "event",
      });

      expect(received).toHaveLength(2);
      expect(received[0].type).toBe("agent_start");
      expect(received[1].turnIndex).toBe(0);
    });

    test("unsubscribe stops receiving events", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const joinPromise = client.joinSession("test-session");
      transport.simulateMessage({
        data: testSnapshot(),
        sessionId: "test-session",
        type: "snapshot",
      });
      await joinPromise;

      const received: any[] = [];
      const unsubscribe = client.subscribeSession("test-session", (e) =>
        received.push(e),
      );

      transport.simulateMessage({
        event: { type: "agent_start" },
        sessionId: "test-session",
        type: "event",
      });
      expect(received).toHaveLength(1);

      unsubscribe();

      transport.simulateMessage({
        event: { type: "agent_end" },
        sessionId: "test-session",
        type: "event",
      });
      expect(received).toHaveLength(1); // Still 1, not 2
    });
  });

  describe("listSessions", () => {
    test("returns list of sessions", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const listPromise = client.listSessions();
      transport.simulateMessage({
        sessions: [
          { createdAt: 0, cwd: "/", id: "s1", messageCount: 0, modifiedAt: 0 },
          {
            createdAt: 0,
            cwd: "/home",
            id: "s2",
            messageCount: 5,
            modifiedAt: 0,
          },
        ],
        type: "session_list",
      });

      const sessions = await listPromise;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("s1");
      expect(sessions[1].id).toBe("s2");
    });
  });

  describe("createSession", () => {
    test("creates session and returns snapshot", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const createPromise = client.createSession("/workspace");
      transport.simulateMessage({
        data: testSnapshot({ cwd: "/workspace", sessionId: "new-session" }),
        sessionId: "new-session",
        type: "snapshot",
      });

      const result = await createPromise;
      expect(result.sessionId).toBe("new-session");
      expect(result.snapshot.cwd).toBe("/workspace");
    });
  });

  describe("deleteSession", () => {
    test("deleteSession sends delete command to server", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      await client.deleteSession("test-session");

      expect(transport.send).toHaveBeenCalledWith({
        sessionId: "test-session",
        type: "delete_session",
      });
    });
  });

  describe("leaveSession", () => {
    test("leaveSession sends leave command to server", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      await client.leaveSession("test-session");

      expect(transport.send).toHaveBeenCalledWith({
        sessionId: "test-session",
        type: "leave_session",
      });
    });
  });

  describe("subscribeGlobal", () => {
    test("receives global events after subscribing", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const received: any[] = [];
      client.subscribeGlobal((e) => received.push(e));

      transport.simulateMessage({
        type: "server_connected",
      });
      transport.simulateMessage({
        info: {
          createdAt: 0,
          cwd: "/",
          id: "new-session",
          messageCount: 0,
          modifiedAt: 0,
        },
        sessionId: "new-session",
        type: "session_created",
      });
      transport.simulateMessage({
        sessionId: "old-session",
        type: "session_deleted",
      });

      expect(received).toHaveLength(3);
      expect(received[0].type).toBe("server_connected");
      expect(received[1].type).toBe("session_created");
      expect(received[1].sessionId).toBe("new-session");
      expect(received[2].type).toBe("session_deleted");
    });

    test("unsubscribe stops receiving global events", async () => {
      const transport = createTransport();
      const client = new AgentSessionClient(transport as any);
      await client.connect();

      const received: any[] = [];
      const unsubscribe = client.subscribeGlobal((e) => received.push(e));

      transport.simulateMessage({
        type: "server_connected",
      });
      expect(received).toHaveLength(1);

      unsubscribe();

      transport.simulateMessage({
        info: {
          createdAt: 0,
          cwd: "/",
          id: "new-session",
          messageCount: 0,
          modifiedAt: 0,
        },
        sessionId: "new-session",
        type: "session_created",
      });
      expect(received).toHaveLength(1); // Still 1, not 2
    });
  });
});
