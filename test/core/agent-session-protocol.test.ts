/**
 * agent-session-protocol — round-trip tests.
 *
 * PLAN-020: pins the wire-format contract. For each variant of
 * `ServerMessage` and `ClientMessage`, serialize → parse → deep
 * equal. Drift between the type and the wire (the bug that bit
 * production as `d8748e37` — the `data: SessionSnapshot` lie
 * in `agent-session-server-types.ts:160`) is caught here.
 */
import { describe, expect, it } from "vitest";

import {
  parseClientMessage,
  parseServerMessage,
  serializeClientMessage,
  serializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../src/core/agent-session-protocol.js";

describe("agent-session-protocol", () => {
  describe("ServerMessage round-trip", () => {
    it("round-trips `welcome`", () => {
      const msg: ServerMessage = { sessionId: "sess_abc", type: "welcome" };
      const parsed = parseServerMessage(serializeServerMessage(msg));
      expect(parsed).toEqual(msg);
    });

    it("round-trips `snapshot` with the canonical `snapshot` field (not `data`)", () => {
      // This is the bug that bit production. The wire shape is
      // `{ sessionId, snapshot, type }` — NOT `{ data, ... }`.
      // The protocol module's `ServerMessage` type matches the
      // wire. The prior lying type declared `data: SessionSnapshot`.
      const snapshot = {
        activeToolNames: [] as readonly string[],
        agent: {
          currentMessage: undefined,
          currentMessageId: undefined,
          isStreaming: false,
          pendingToolCalls: [] as {
            args: unknown;
            partialResult?: unknown;
            toolCallId: string;
            toolName: string;
          }[],
        },
        availableThinkingLevels: ["off", "low", "medium", "high"] as const,
        cwd: "/",
        leafId: null,
        messages: [],
        queue: { followUp: [], steering: [] },
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
        sessionId: "sess_abc",
        thinkingLevel: "medium" as const,
      };
      const msg: ServerMessage = {
        sessionId: "sess_abc",
        snapshot,
        type: "snapshot",
      };
      const wire = serializeServerMessage(msg);
      // The wire must NOT contain a `data` key. If a future
      // refactor adds one, this test fails.
      expect(wire).not.toMatch(/"data":/);
      const parsed = parseServerMessage(wire);
      expect(parsed).toEqual(msg);
    });

    it("round-trips `event` with sequenceId", () => {
      const msg: ServerMessage = {
        event: {
          activeToolNames: ["foo"],
          type: "tools_changed",
        } as ServerMessage extends { event: infer E } ? E : never,
        sequenceId: 42,
        sessionId: "sess_abc",
        type: "event",
      };
      const parsed = parseServerMessage(serializeServerMessage(msg));
      expect(parsed).toEqual(msg);
    });

    it("round-trips `error`", () => {
      const msg: ServerMessage = {
        message: "something went wrong",
        sessionId: "sess_abc",
        type: "error",
      };
      const parsed = parseServerMessage(serializeServerMessage(msg));
      expect(parsed).toEqual(msg);
    });

    it("round-trips `version`", () => {
      const msg: ServerMessage = { type: "version", version: 7 };
      const parsed = parseServerMessage(serializeServerMessage(msg));
      expect(parsed).toEqual(msg);
    });
  });

  describe("ClientMessage round-trip", () => {
    it("round-trips `command`", () => {
      const msg: ClientMessage = {
        command: { prompt: "hi", type: "prompt" },
        type: "command",
      };
      const parsed = parseClientMessage(serializeClientMessage(msg));
      expect(parsed).toEqual(msg);
    });

    it("round-trips `ping`", () => {
      const msg: ClientMessage = { type: "ping" };
      const parsed = parseClientMessage(serializeClientMessage(msg));
      expect(parsed).toEqual(msg);
    });
  });

  describe("parse failures", () => {
    it("throws on malformed JSON", () => {
      expect(() => parseServerMessage("{not json")).toThrow();
      expect(() => parseClientMessage("{not json")).toThrow();
    });

    it("throws on unknown variant", () => {
      // No `type` field.
      expect(() =>
        parseServerMessage(JSON.stringify({ foo: "bar" })),
      ).toThrow();
      // Wrong discriminator value.
      expect(() =>
        parseServerMessage(JSON.stringify({ sessionId: "x", type: "unknown" })),
      ).toThrow();
    });
  });
});
