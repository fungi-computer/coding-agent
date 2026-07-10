import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SessionManager } from "../../src/core/session-manager.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from "../../src/core/compaction/compaction.js";
import type { AgentMessage } from "@shiit/agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

/**
 * ARCH-161: getBranch() walks the full parent chain past compaction, so
 * long sessions produce 3+ MB snapshots and OOM the DO. getContextPath()
 * is the bounded variant: it stops at the most recent compaction entry
 * walking from leaf to root, so callers that build LLM-visible artifacts
 * (snapshot, prepareCompaction input) see only post-compaction content
 * plus the compaction summary itself.
 */

const userMessage = (text: string): UserMessage => ({
  content: text,
  role: "user",
  timestamp: Date.now(),
});

const assistantMessage = (text: string): AssistantMessage => ({
  content: [{ text, type: "text" }],
  model: "test-model",
  provider: "test-provider",
  role: "assistant",
  stopReason: "stop",
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-manager-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const makeManager = (): SessionManager => SessionManager.create("/tmp", tmpDir);

describe("SessionManager.getContextPath", () => {
  test("returns the full path when there is no compaction", () => {
    const m = makeManager();
    m.appendMessage(userMessage("hello"));
    m.appendMessage(assistantMessage("hi"));

    const full = m.getBranch();
    const bounded = m.getContextPath();

    expect(full.length).toBe(2);
    expect(bounded.length).toBe(2);
    expect(bounded.map((e) => e.id)).toEqual(full.map((e) => e.id));
  });

  test("stops at the most recent compaction's firstKeptEntryId", () => {
    const m = makeManager();
    m.appendMessage(userMessage("a"));
    m.appendMessage(assistantMessage("a"));
    m.appendMessage(userMessage("b"));
    m.appendMessage(assistantMessage("b"));
    const firstKept = m.getLeafId()!;
    m.appendCompaction("summary of a+b", firstKept, 100);
    m.appendMessage(userMessage("c"));
    m.appendMessage(assistantMessage("c"));
    m.appendMessage(userMessage("d"));
    m.appendMessage(assistantMessage("d"));

    const full = m.getBranch();
    const bounded = m.getContextPath();

    // Full path: 4 pre-compaction messages + 1 compaction + 4 post-compaction = 9
    expect(full.length).toBe(9);
    // Bounded path: 1 kept message (firstKept) + 1 compaction + 4 post-compaction = 6
    expect(bounded.length).toBe(6);
    // The first entry in the bounded path is the firstKept message
    expect(bounded[0].id).toBe(firstKept);
    // The second entry is the compaction
    expect(bounded[1].type).toBe("compaction");
    // The last entry is the leaf
    expect(bounded[bounded.length - 1].id).toBe(m.getLeafId());
    // The pre-compaction messages that are NOT in the kept tail are
    // excluded from the bounded path
    const boundedIds = new Set(bounded.map((e) => e.id));
    expect(boundedIds.has(firstKept)).toBe(true);
  });

  // ARCH-161: _checkCompaction and _runAutoCompaction hand the bounded
  // path to prepareCompaction. The bounded path's first entry is the
  // most recent compaction, and prepareCompaction should identify that
  // as the boundary — not look for an earlier one.
  test("prepareCompaction with bounded path uses the most recent compaction as boundary", () => {
    const m = makeManager();
    m.appendMessage(userMessage("a"));
    m.appendMessage(assistantMessage("a"));
    const firstKept1 = m.getLeafId()!;
    const comp1 = m.appendCompaction("summary 1", firstKept1, 100);
    m.appendMessage(userMessage("b"));
    m.appendMessage(assistantMessage("b"));
    const firstKept2 = m.getLeafId()!;
    const comp2 = m.appendCompaction("summary 2", firstKept2, 200);
    m.appendMessage(userMessage("c"));
    m.appendMessage(assistantMessage("c"));

    const bounded = m.getContextPath();
    // Bounded path starts with firstKept2 (the first kept message of
    // the most recent compaction), then the compaction, then the
    // post-compaction messages
    expect(bounded[0].id).toBe(firstKept2);
    expect(bounded[1].id).toBe(comp2);
    expect(bounded[1].type).toBe("compaction");

    const preparation = prepareCompaction(bounded, DEFAULT_COMPACTION_SETTINGS);

    expect(preparation).toBeDefined();
    // The boundary should point to the entry just after comp2
    // (which is the first post-compaction message)
    expect(preparation!.firstKeptEntryId).toBeDefined();
    // The first kept entry must be a post-compaction message, not
    // pre-compaction-1 or the older compaction
    expect(preparation!.firstKeptEntryId).not.toBe(firstKept1);
    expect(preparation!.firstKeptEntryId).not.toBe(comp1);
    expect(preparation!.firstKeptEntryId).not.toBe(comp2);
  });

  // ARCH-161 regression: the original bug (snapshot OOM at 3.1 MB)
  // was caused by getBranch() returning the full 1500+-entry path
  // even after compaction. The session `H6RVVpMH49nQAQkxm2j76`
  // (sick.txt) had 1553 entries with 1 compaction; getContextPath()
  // must produce a path that's at most keepRecentTokens worth of
  // messages long, so the WS snapshot stays well under the DO
  // memory limit.
  test("getContextPath keeps the working set bounded on long sessions", () => {
    const m = makeManager();

    // Pre-compaction: 1000 user/assistant turns (~2000 messages)
    for (let i = 0; i < 1000; i++) {
      m.appendMessage(userMessage(`pre-user ${i}`));
      m.appendMessage(assistantMessage(`pre-reply ${i}`));
    }

    // Compact (keep from the most recent pre-compaction user onward)
    const firstKept = m
      .getEntries()
      .reverse()
      .find((e) => e.type === "message" && (e as any).message.role === "user")!;
    m.appendCompaction(
      "summary of the pre-compaction era",
      firstKept.id,
      50000,
    );

    // Post-compaction: 50 more user/assistant turns (~100 messages)
    for (let i = 0; i < 50; i++) {
      m.appendMessage(userMessage(`post-user ${i}`));
      m.appendMessage(assistantMessage(`post-reply ${i}`));
    }

    const full = m.getBranch();
    const bounded = m.getContextPath();

    // 2000 pre-compaction + 1 compaction + 100 post-compaction = 2101 full
    expect(full.length).toBe(2101);
    // 2 kept messages (user + assistant of the kept turn) + 1
    // compaction + 100 post-compaction = 103 bounded
    expect(bounded.length).toBe(103);

    // Bounded path is ~20x shorter than the full path. This is
    // what keeps the snapshot small enough to not OOM the DO.
    expect(bounded.length).toBeLessThan(full.length / 10);
  });

  // ARCH-161 followup: buildSessionContext resolves thinkingLevel
  // and model by walking the path. The bounded path is correct for
  // messages, but session-level settings (thinking level, model) are
  // captured from any point in the session's history — if a user
  // set thinking_level=high pre-compaction, restoring the session
  // should still see "high", not the default. The bounded path
  // includes the compaction summary and post-compaction entries; the
  // full path also includes pre-compaction entries. We want the
  // session-level resolution to span the full path.
  test("buildSessionContext resolves thinkingLevel from the full path, not the bounded path", () => {
    const m = makeManager();

    // Set thinking level pre-compaction
    m.appendMessage(userMessage("a"));
    m.appendMessage(assistantMessage("a"));
    m.appendThinkingLevelChange("high");

    // Compact
    const firstKept = m.getLeafId()!;
    m.appendCompaction("summary", firstKept, 100);

    // Post-compaction: no thinking_level_change, so the bounded
    // path's thinkingLevel would default to "off" if we used only
    // the bounded path. The full path still contains the
    // pre-compaction "high" setting.
    m.appendMessage(userMessage("b"));
    m.appendMessage(assistantMessage("b"));

    const ctx = m.buildSessionContext();
    expect(ctx.thinkingLevel).toBe("high");
  });

  test("includes the kept tail when the leaf is the compaction itself", () => {
    const m = makeManager();
    m.appendMessage(userMessage("a"));
    m.appendMessage(assistantMessage("a"));
    // firstKept is the user message that starts the kept turn
    // (the assistant message that comes after is what we want to
    // keep in the LLM context along with its user prompt)
    const firstKept = m
      .getEntries()
      .find(
        (e) => e.type === "message" && (e as any).message.role === "user",
      )!.id;
    const compactionId = m.appendCompaction("summary", firstKept, 100);

    // Don't append anything post-compaction. Leaf is the compaction.
    const bounded = m.getContextPath();

    // Bounded path: kept tail (user, assistant) + compaction
    expect(bounded.length).toBe(3);
    // The first entry is the firstKept message (the user message)
    expect(bounded[0].id).toBe(firstKept);
    // The last entry is the compaction (the leaf)
    expect(bounded[bounded.length - 1].id).toBe(compactionId);
    expect(bounded[bounded.length - 1].type).toBe("compaction");
  });

  test("respects the most recent compaction when there are multiple", () => {
    const m = makeManager();
    m.appendMessage(userMessage("a"));
    m.appendMessage(assistantMessage("a"));
    const firstKept1 = m.getLeafId()!;
    m.appendCompaction("summary 1", firstKept1, 100);
    m.appendMessage(userMessage("b"));
    m.appendMessage(assistantMessage("b"));
    const firstKept2 = m.getLeafId()!;
    m.appendCompaction("summary 2", firstKept2, 200);
    m.appendMessage(userMessage("c"));
    m.appendMessage(assistantMessage("c"));

    const bounded = m.getContextPath();

    // The first entry is the firstKept of the most recent compaction
    expect(bounded[0].id).toBe(firstKept2);
    // Bounded path is bounded; full path is larger
    const full = m.getBranch();
    expect(full.length).toBeGreaterThan(bounded.length);
    // summary 1 is NOT in the bounded path
    const boundedIds = new Set(bounded.map((e) => e.id));
    const summary1 = full.find(
      (e) => e.type === "compaction" && (e as any).summary === "summary 1",
    );
    expect(summary1).toBeDefined();
    expect(boundedIds.has(summary1!.id)).toBe(false);
  });
});
