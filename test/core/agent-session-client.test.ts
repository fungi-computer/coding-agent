import { describe, test, expect, vi } from "vitest";
import { AgentSessionClient } from "../../src/core/agent-session-client.js";

const createTransport = () => {
	const handlers: Set<(msg: any) => void> = new Set();

	return {
		handlers,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		send: vi.fn(),
		onMessage: vi.fn((handler: (msg: any) => void) => {
			handlers.add(handler);
		}),
		onClose: vi.fn(),
		simulateMessage: (msg: any) => {
			for (const handler of handlers) {
				handler(msg);
			}
		},
	};
};

const testSnapshot = (overrides?: { sessionId?: string; cwd?: string }) => ({
	sessionId: overrides?.sessionId ?? "test-session",
	cwd: overrides?.cwd ?? "/",
	leafId: "leaf-1",
	branchEntries: [],
	thinkingLevel: "medium" as const,
	availableThinkingLevels: ["off", "low", "medium", "high"] as const,
	activeToolNames: ["read", "bash"] as const,
	queue: { steering: [] as const, followUp: [] as const },
	agent: { isStreaming: false, pendingToolCalls: [] },
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
				type: "snapshot",
				sessionId: "test-session",
				data: testSnapshot({ sessionId: "test-session" }),
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
				type: "snapshot",
				sessionId: "test-session",
				data: testSnapshot({ sessionId: "test-session", cwd: "/home" }),
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
				type: "snapshot",
				sessionId: "test-session",
				data: testSnapshot(),
			});
			await joinPromise;

			// Send command
			await client.command("test-session", { type: "prompt", text: "hello" });

			expect(transport.send).toHaveBeenCalledWith({
				type: "command",
				sessionId: "test-session",
				command: { type: "prompt", text: "hello" },
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
				type: "snapshot",
				sessionId: "test-session",
				data: testSnapshot(),
			});
			await joinPromise;

			// Subscribe to events
			const received: any[] = [];
			client.subscribeSession("test-session", (e) => received.push(e));

			// Receive events
			transport.simulateMessage({
				type: "event",
				sessionId: "test-session",
				event: { type: "agent_start" },
			});
			transport.simulateMessage({
				type: "event",
				sessionId: "test-session",
				event: { type: "turn_start", turnIndex: 0 },
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
				type: "snapshot",
				sessionId: "test-session",
				data: testSnapshot(),
			});
			await joinPromise;

			const received: any[] = [];
			const unsubscribe = client.subscribeSession("test-session", (e) => received.push(e));

			transport.simulateMessage({
				type: "event",
				sessionId: "test-session",
				event: { type: "agent_start" },
			});
			expect(received).toHaveLength(1);

			unsubscribe();

			transport.simulateMessage({
				type: "event",
				sessionId: "test-session",
				event: { type: "agent_end" },
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
				type: "session_list",
				sessions: [
					{ id: "s1", cwd: "/", createdAt: 0, modifiedAt: 0, messageCount: 0 },
					{ id: "s2", cwd: "/home", createdAt: 0, modifiedAt: 0, messageCount: 5 },
				],
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
				type: "snapshot",
				sessionId: "new-session",
				data: testSnapshot({ sessionId: "new-session", cwd: "/workspace" }),
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
				type: "delete_session",
				sessionId: "test-session",
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
				type: "leave_session",
				sessionId: "test-session",
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
				type: "session_created",
				sessionId: "new-session",
				info: { id: "new-session", cwd: "/", createdAt: 0, modifiedAt: 0, messageCount: 0 },
			});
			transport.simulateMessage({
				type: "session_deleted",
				sessionId: "old-session",
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
				type: "session_created",
				sessionId: "new-session",
				info: { id: "new-session", cwd: "/", createdAt: 0, modifiedAt: 0, messageCount: 0 },
			});
			expect(received).toHaveLength(1); // Still 1, not 2
		});
	});
});
