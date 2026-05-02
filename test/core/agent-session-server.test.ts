import { describe, test, expect, beforeEach, vi } from "vitest";
import { AgentSessionServer } from "../../src/core/agent-session-server.js";
import { InMemoryTransport } from "../../src/core/in-memory-transport.js";
import { InMemorySessionStore } from "../../src/core/in-memory-session-store.js";
import type { SessionFactory } from "../../src/core/agent-session-server-types.js";
import type { AgentSession } from "../../src/core/agent-session.js";

const createMockSessionFactory = (session?: Partial<AgentSession> | null): SessionFactory => {
	const defaultSession: Partial<AgentSession> = {
		sessionId: "",
		thinkingLevel: "medium",
		isStreaming: false,
		getActiveToolNames: vi.fn().mockReturnValue([]),
		subscribe: vi.fn().mockReturnValue(() => {}),
		dispose: vi.fn(),
		prompt: vi.fn().mockResolvedValue(undefined),
		abort: vi.fn(),
		setModel: vi.fn().mockResolvedValue(undefined),
		setThinkingLevel: vi.fn(),
		setActiveToolsByName: vi.fn(),
		navigateTree: vi.fn().mockResolvedValue(undefined),
		compact: vi.fn().mockResolvedValue(undefined),
	};
	return {
		createSession: vi.fn().mockResolvedValue(session ?? defaultSession),
		closeSession: vi.fn().mockResolvedValue(undefined),
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
			const server = new AgentSessionServer(store, createMockSessionFactory(), mockModelRegistry, transport);

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
			const server = new AgentSessionServer(store, createMockSessionFactory(), mockModelRegistry, transport);

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
			const server = new AgentSessionServer(store, createMockSessionFactory(), mockModelRegistry, transport);

			const events: any[] = [];
			server.subscribeGlobal((e) => events.push(e));

			await server.start();

			expect(events).toContainEqual({ type: "server_connected" });

			await server.stop();
		});

		test("stop emits server_shutdown event", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();
			const server = new AgentSessionServer(store, createMockSessionFactory(), mockModelRegistry, transport);

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
			const server = new AgentSessionServer(store, createMockSessionFactory(), mockModelRegistry, transport);

			const globalEvents: any[] = [];
			server.subscribeGlobal((e) => globalEvents.push(e));

			await server.start();
			await server.createSession("/tmp");

			const sessionCreated = globalEvents.find((e) => e.type === "session_created");
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
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			const { sessionId } = await server.createSession("/tmp");

			await server.leaveSession(sessionId);

			expect(factory.closeSession).toHaveBeenCalledWith(sessionId);
			expect(factory.createSession({ sessionId, cwd: "/tmp" })).toBeDefined();

			await server.stop();
		});

		test("deleteSession disposes session and deletes from store", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();
			const factory = createMockSessionFactory();
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

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
				sessionId: "test",
				getActiveToolNames: vi.fn().mockReturnValue([]),
				subscribe: vi.fn().mockReturnValue(() => {}),
				dispose: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				setThinkingLevel: vi.fn(),
				setActiveToolsByName: vi.fn(),
				navigateTree: vi.fn().mockResolvedValue(undefined),
				compact: vi.fn().mockResolvedValue(undefined),
			};
			const factory = createMockSessionFactory(mockSession as unknown as AgentSession);
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			const { sessionId } = await server.createSession("/tmp");

			await server.command(sessionId, { type: "prompt", text: "Hello" });

			expect(mockSession.prompt).toHaveBeenCalledWith("Hello");

			await server.stop();
		});

		test("set_thinking_level command calls session.setThinkingLevel", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();
			const mockSession = {
				sessionId: "test",
				getActiveToolNames: vi.fn().mockReturnValue([]),
				subscribe: vi.fn().mockReturnValue(() => {}),
				dispose: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				setThinkingLevel: vi.fn(),
				setActiveToolsByName: vi.fn(),
				navigateTree: vi.fn().mockResolvedValue(undefined),
				compact: vi.fn().mockResolvedValue(undefined),
			};
			const factory = createMockSessionFactory(mockSession as unknown as AgentSession);
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			const { sessionId } = await server.createSession("/tmp");

			await server.command(sessionId, { type: "set_thinking_level", level: "high" });

			expect(mockSession.setThinkingLevel).toHaveBeenCalledWith("high");

			await server.stop();
		});

		test("command throws if session not found", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();
			const factory = createMockSessionFactory();
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();

			await expect(server.command("nonexistent", { type: "prompt", text: "hi" })).rejects.toThrow("Session not found");

			await server.stop();
		});

		test("set_model command resolves model via ModelRegistry and calls session.setModel", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();
			const mockModel = { provider: "anthropic", id: "claude-3-5-sonnet" };
			const mockModelRegistry = {
				find: vi.fn().mockReturnValue(mockModel),
			};
			const mockSession = {
				sessionId: "test",
				getActiveToolNames: vi.fn().mockReturnValue([]),
				subscribe: vi.fn().mockReturnValue(() => {}),
				dispose: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				setModel: vi.fn().mockResolvedValue(undefined),
				setThinkingLevel: vi.fn(),
				setActiveToolsByName: vi.fn(),
				navigateTree: vi.fn().mockResolvedValue(undefined),
				compact: vi.fn().mockResolvedValue(undefined),
			};
			const factory = createMockSessionFactory(mockSession as unknown as AgentSession);
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			const { sessionId } = await server.createSession("/tmp");

			await server.command(sessionId, { type: "set_model", modelId: "claude-3-5-sonnet", provider: "anthropic" });

			expect(mockModelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-3-5-sonnet");
			expect(mockSession.setModel).toHaveBeenCalledWith(mockModel);

			await server.stop();
		});
	});

	describe("session event wiring", () => {
		test("session events are forwarded to subscribers", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();

			const mockSession = {
				sessionId: "test-session",
				cwd: "/tmp",
				model: undefined,
				thinkingLevel: "medium" as const,
				isStreaming: false,
				sessionName: undefined,
				leafId: null,
				activeToolNames: [] as string[],
				getActiveToolNames: vi.fn().mockReturnValue([]),
				prompt: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				setModel: vi.fn().mockResolvedValue(undefined),
				setThinkingLevel: vi.fn(),
				setActiveToolsByName: vi.fn(),
				navigateTree: vi.fn().mockResolvedValue(undefined),
				compact: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				subscribe: vi.fn((listener: (event: any) => void) => {
					mockSession._listener = listener;
					return () => {
						mockSession._listener = undefined;
					};
				}),
				_listener: undefined as ((event: any) => void) | undefined,
			};

			const factory = createMockSessionFactory(mockSession as unknown as AgentSession);
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			const { sessionId } = await server.createSession("/tmp");

			const sessionEvents: any[] = [];
			server.subscribeSession(sessionId, (e) => sessionEvents.push(e));

			mockSession._listener?.({ type: "model_changed", model: undefined, previousModel: undefined, source: "set" });

			expect(sessionEvents.length).toBe(1);
			expect(sessionEvents[0].type).toBe("model_changed");

			await server.stop();
		});

		test("joinSession wires existing session and forwards events", async () => {
			const transport = new InMemoryTransport();
			const store = new InMemorySessionStore();

			const { sessionId } = await store.createSession("/test");

			const mockSession = {
				sessionId,
				cwd: "/test",
				model: undefined,
				thinkingLevel: "medium" as const,
				isStreaming: false,
				sessionName: undefined,
				leafId: null,
				activeToolNames: [] as string[],
				getActiveToolNames: vi.fn().mockReturnValue([]),
				prompt: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn(),
				setModel: vi.fn().mockResolvedValue(undefined),
				setThinkingLevel: vi.fn(),
				setActiveToolsByName: vi.fn(),
				navigateTree: vi.fn().mockResolvedValue(undefined),
				compact: vi.fn().mockResolvedValue(undefined),
				dispose: vi.fn(),
				subscribe: vi.fn((listener: (event: any) => void) => {
					mockSession._listener = listener;
					return () => {
						mockSession._listener = undefined;
					};
				}),
				_listener: undefined as ((event: any) => void) | undefined,
			};

			const factory = createMockSessionFactory(mockSession as unknown as AgentSession);
			const server = new AgentSessionServer(store, factory, mockModelRegistry, transport);

			await server.start();
			await server.joinSession(sessionId);

			const sessionEvents: any[] = [];
			server.subscribeSession(sessionId, (e) => sessionEvents.push(e));

			mockSession._listener?.({ type: "thinking_level_changed", level: "high", availableLevels: ["off", "low", "medium", "high"] });

			expect(sessionEvents.length).toBe(1);
			expect(sessionEvents[0].type).toBe("thinking_level_changed");

			await server.stop();
		});
	});
});
