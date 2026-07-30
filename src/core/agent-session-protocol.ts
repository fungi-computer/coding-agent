/**
 * Agent session WebSocket protocol — the canonical wire format
 * between the agent DO (server) and chat/CLI clients.
 *
 * This file is the single source of truth for what crosses the
 * WebSocket. Both sides import `parseServerMessage` /
 * `serializeServerMessage` from here. Drift is caught at compile
 * time (the discriminated union) and at test time
 * (`protocol-roundtrip.test.ts`).
 *
 * PLAN-020: replaces the lying type in
 * `agent-session-server-types.ts:160` that declared
 * `{ data: SessionSnapshot; ... }` while the wire actually
 * emitted `{ snapshot: SessionSnapshot; ... }`. The chat was
 * reading the wire correctly but the type was wrong; the fix is
 * to make the type match the wire and have both sides go through
 * these parsers.
 *
 * The protocol is JSON, one message per WS frame, no envelope.
 */

import { Schema } from "effect";

import type {
  AgentSessionSyncEvent,
  SessionCommand,
  SessionSnapshot,
} from "./agent-session-server-types.js";

// ============================================================================
// Identity (per-WebSocket binding)
// ============================================================================

/**
 * Per-WS identity. Set at attach, read at hibernation recovery.
 * Sent in the `X-User-Id` / `X-Team-Id` headers on the upgrade
 * request; persisted via `ws.serializeAttachment()` so a recovered
 * WS can re-attach without re-asking.
 */
export interface Identity {
  readonly teamId: string;
  readonly userId: string;
}

/**
 * The shape that gets `ws.serializeAttachment`'d at attach time.
 * It is read in `webSocketMessage` after a DO hibernation to
 * recover the session binding. `Identity` is the inbound shape;
 * `PersistedAttachment` is what survives the hibernation cycle.
 */
export interface PersistedAttachment extends Identity {
  readonly sessionId: string;
}

// ============================================================================
// Server → Client
// ============================================================================

/**
 * Server-to-client messages over the agent session WebSocket.
 *
 * Tagged union. The `type` field is the discriminator. Each
 * variant carries its own required fields; the chat's `onMessage`
 * handler does an exhaustive switch over this union.
 */
export type ServerMessage =
  | { readonly sessionId: string; readonly type: "welcome" }
  | {
      readonly sessionId: string;
      readonly snapshot: SessionSnapshot;
      readonly type: "snapshot";
    }
  | {
      readonly event: AgentSessionSyncEvent;
      readonly sessionId: string;
      readonly sequenceId: number;
      readonly type: "event";
    }
  | {
      readonly message: string;
      readonly sessionId: string;
      readonly type: "error";
      // PLAN-028 phase 1: typed failure taxonomy for the client
      // state machine. Optional; `terminal` tells the client to
      // stop retrying.
      readonly kind?: string;
      readonly terminal?: boolean;
    }
  | { readonly type: "version"; readonly version: number };

// ============================================================================
// Client → Server
// ============================================================================

/**
 * Client-to-server messages. The client sends `command` to drive
 * the agent (prompt, abort, set_model, etc.) and `ping` to keep
 * the connection alive through proxies.
 */
export type ClientMessage =
  | { readonly command: SessionCommand; readonly type: "command" }
  | { readonly type: "ping" };

// ============================================================================
// Schemas (for parse/serialize with Effect Schema)
// ============================================================================

/**
 * `Schema<unknown>` is intentional: `event`, `command`, and
 * `snapshot` carry payloads whose runtime shape lives in the
 * `agent-session-*` modules. The protocol's job is to be the
 * contract for *which* variants exist on the wire, not to
 * re-validate the inner payloads (they have their own parsers
 * downstream).
 */
export const ServerMessageSchema: Schema.Schema<ServerMessage> = Schema.Union(
  Schema.Struct({
    sessionId: Schema.String,
    type: Schema.Literal("welcome"),
  }),
  Schema.Struct({
    sessionId: Schema.String,
    snapshot: Schema.Any,
    type: Schema.Literal("snapshot"),
  }),
  Schema.Struct({
    event: Schema.Any,
    sessionId: Schema.String,
    sequenceId: Schema.Number,
    type: Schema.Literal("event"),
  }),
  Schema.Struct({
    message: Schema.String,
    sessionId: Schema.String,
    type: Schema.Literal("error"),
    // PLAN-028 phase 1: typed failure taxonomy for the client state
    // machine. Optional so older producers stay wire-compatible;
    // `terminal` tells the client to stop retrying.
    kind: Schema.optional(Schema.String),
    terminal: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("version"), version: Schema.Number }),
);

export const ClientMessageSchema: Schema.Schema<ClientMessage> = Schema.Union(
  Schema.Struct({ command: Schema.Any, type: Schema.Literal("command") }),
  Schema.Struct({ type: Schema.Literal("ping") }),
);

// ============================================================================
// Parse / serialize
// ============================================================================

/**
 * Parse a single WS frame into a `ServerMessage`. Throws on
 * malformed JSON or unknown variant; the caller is expected to
 * catch and drop the frame (per-WS best-effort).
 *
 * We use `decodeUnknownSync` (not `decodeUnknown`) because the
 * WS frame is already a string and the parser is the only thing
 * in the hot path; an async parse would cost a microtask per
 * frame.
 */
export const parseServerMessage = (raw: string): ServerMessage =>
  Schema.decodeUnknownSync(ServerMessageSchema)(JSON.parse(raw));

/**
 * Parse a single WS frame into a `ClientMessage`. Throws on
 * malformed JSON or unknown variant; the server drops unknown
 * frames per-WS.
 */
export const parseClientMessage = (raw: string): ClientMessage =>
  Schema.decodeUnknownSync(ClientMessageSchema)(JSON.parse(raw));

/**
 * Serialize a `ServerMessage` to a WS frame string. The schema's
 * `encodeSync` is structural — it preserves the field order of
 * the source object, so the wire output is deterministic for
 * tests.
 */
export const serializeServerMessage = (msg: ServerMessage): string =>
  JSON.stringify(Schema.encodeSync(ServerMessageSchema)(msg));

/**
 * Serialize a `ClientMessage` to a WS frame string. Symmetric to
 * `serializeServerMessage`.
 */
export const serializeClientMessage = (msg: ClientMessage): string =>
  JSON.stringify(Schema.encodeSync(ClientMessageSchema)(msg));
