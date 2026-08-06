import { describe, expect, test, vi } from "vitest";

import type { AgentMessage } from "@shiit/agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

import { AgentSession } from "../../src/core/agent-session.js";
import { SessionManager } from "../../src/core/session-manager.js";

const userMessage = (text: string): UserMessage => ({
  content: text,
  role: "user",
  timestamp: Date.now(),
});

const assistantMessage = (
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
  api: "test-api",
  content: text.length > 0 ? [{ text, type: "text" }] : [],
  model: "test-model",
  provider: "test-provider",
  role: "assistant",
  stopReason,
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const makeSession = (
  messages: AgentMessage[],
  manager: SessionManager,
): AgentSession => {
  const session = Object.create(AgentSession.prototype) as AgentSession;
  Object.defineProperty(session, "messages", {
    configurable: true,
    value: messages,
    writable: true,
  });
  Object.defineProperty(session, "sessionManager", {
    configurable: true,
    value: manager,
    writable: true,
  });
  return session;
};

describe("AgentSession.getLastAssistantText", () => {
  test("returns text from the most recent assistant message in memory", () => {
    const session = makeSession(
      [userMessage("hello"), assistantMessage("hi there")],
      SessionManager.inMemory("/"),
    );
    expect(session.getLastAssistantText()).toBe("hi there");
  });

  test("falls back to persisted entries when the in-memory message list was compacted", () => {
    const manager = SessionManager.inMemory("/");
    manager.newSession();
    manager.appendMessage(userMessage("hello"));
    manager.appendMessage(assistantMessage("compact me"));
    manager.appendCompaction("summary", manager.getLeafId()!, 1000);

    // Simulate compaction replacing agent.state.messages with only the summary.
    const session = makeSession([], manager);
    expect(session.getLastAssistantText()).toBe("compact me");
  });

  test("falls back to persisted entries for an aborted assistant turn with no in-memory text", () => {
    const manager = SessionManager.inMemory("/");
    manager.newSession();
    manager.appendMessage(userMessage("hello"));
    manager.appendMessage(assistantMessage("partial work"));

    // Empty aborted message present in memory, so the in-memory pass yields nothing.
    const session = makeSession(
      [userMessage("hello"), assistantMessage("", "aborted")],
      manager,
    );
    expect(session.getLastAssistantText()).toBe("partial work");
  });
});

describe("AgentSession.resume", () => {
  test("calls agent.continue when idle", async () => {
    const continueFn = vi.fn().mockResolvedValue(undefined);
    const session = Object.create(AgentSession.prototype) as AgentSession;
    Object.defineProperty(session, "agent", {
      value: { continue: continueFn },
      writable: true,
    });

    await (session as any).resume();

    expect(continueFn).toHaveBeenCalledOnce();
  });

  test("active run is a no-op (agent.continue throws)", async () => {
    const continueFn = vi
      .fn()
      .mockRejectedValue(new Error("Agent is already processing"));
    const session = Object.create(AgentSession.prototype) as AgentSession;
    Object.defineProperty(session, "agent", {
      value: { continue: continueFn },
      writable: true,
    });

    // Must not throw — resume swallows errors from agent.continue
    await expect((session as any).resume()).resolves.toBeUndefined();

    expect(continueFn).toHaveBeenCalledOnce();
  });

  test("no last message is a no-op (degenerate gracefully)", async () => {
    const continueFn = vi
      .fn()
      .mockRejectedValue(new Error("No messages to continue from"));
    const session = Object.create(AgentSession.prototype) as AgentSession;
    Object.defineProperty(session, "agent", {
      value: { continue: continueFn },
      writable: true,
    });

    await expect((session as any).resume()).resolves.toBeUndefined();

    expect(continueFn).toHaveBeenCalledOnce();
  });
});
