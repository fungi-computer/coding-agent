/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AssistantMessage, Model, Usage } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@shiit/agent-core";

import { completeSimple } from "@mariozechner/pi-ai";

import {
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import {
  buildSessionContext,
  type CompactionEntry,
  type SessionEntry,
} from "../session-manager.js";
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  type FileOperations,
  formatFileOperations,
  serializeConversation,
  SUMMARIZATION_SYSTEM_PROMPT,
} from "./utils.js";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
  modifiedFiles: string[];
  readFiles: string[];
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
  /** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
  details?: T;
  firstKeptEntryId: string;
  summary: string;
  tokensBefore: number;
}

// ============================================================================
// Message Extraction
// ============================================================================

export interface CompactionSettings {
  enabled: boolean;
  keepRecentTokens: number;
  reserveTokens: number;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
  messages: AgentMessage[],
  entries: SessionEntry[],
  prevCompactionIndex: number,
): FileOperations {
  const fileOps = createFileOps();

  // Collect from previous compaction's details (if pi-generated)
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    if (!prevCompaction.fromHook && prevCompaction.details) {
      // fromHook field kept for session file compatibility
      const details = prevCompaction.details as CompactionDetails;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) fileOps.read.add(f);
      }
      if (Array.isArray(details.modifiedFiles)) {
        for (const f of details.modifiedFiles) fileOps.edited.add(f);
      }
    }
  }

  // Extract from tool calls in messages
  for (const msg of messages) {
    extractFileOpsFromMessage(msg, fileOps);
  }

  return fileOps;
}

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "custom_message") {
    return createCustomMessage(
      entry.customType,
      entry.content,
      entry.display,
      entry.details,
      entry.timestamp,
    );
  }
  if (entry.type === "branch_summary") {
    return createBranchSummaryMessage(
      entry.summary,
      entry.fromId,
      entry.timestamp,
    );
  }
  if (entry.type === "compaction") {
    return createCompactionSummaryMessage(
      entry.summary,
      entry.tokensBefore,
      entry.timestamp,
    );
  }
  return undefined;
}

// ============================================================================
// Types
// ============================================================================

function getMessageFromEntryForCompaction(
  entry: SessionEntry,
): AgentMessage | undefined {
  if (entry.type === "compaction") {
    return undefined;
  }
  return getMessageFromEntry(entry);
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  keepRecentTokens: 20000,
  reserveTokens: 16384,
};

// ============================================================================
// Token calculation
// ============================================================================

export interface ContextUsageEstimate {
  lastUsageIndex: null | number;
  tokens: number;
  trailingTokens: number;
  usageTokens: number;
}

export interface CutPointResult {
  /** Index of first entry to keep */
  firstKeptEntryIndex: number;
  /** Whether this cut splits a turn (cut point is not a user message) */
  isSplitTurn: boolean;
  /** Index of user message that starts the turn being split, or -1 if not splitting */
  turnStartIndex: number;
}

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(
  messages: AgentMessage[],
): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return {
      lastUsageIndex: null,
      tokens: estimated,
      trailingTokens: estimated,
      usageTokens: 0,
    };
  }

  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    lastUsageIndex: usageInfo.index,
    tokens: usageTokens + trailingTokens,
    trailingTokens,
    usageTokens,
  };
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  switch (message.role) {
    case "assistant": {
      const assistant = message as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "branchSummary":
    case "compactionSummary": {
      chars = message.summary.length;
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult": {
      if (typeof message.content === "string") {
        chars = message.content.length;
      } else {
        for (const block of message.content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
          if (block.type === "image") {
            chars += 4800; // Estimate images as 4000 chars, or 1200 tokens
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "user": {
      const content = (
        message as { content: { text?: string; type: string }[] | string }
      ).content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            chars += block.text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
  }

  return 0;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

  if (cutPoints.length === 0) {
    return {
      firstKeptEntryIndex: startIndex,
      isSplitTurn: false,
      turnStartIndex: -1,
    };
  }

  // Walk backwards from newest, accumulating estimated message sizes
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;

    // Estimate this message's size
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;

    // Check if we've exceeded the budget
    if (accumulatedTokens >= keepRecentTokens) {
      // Find the closest valid cut point at or after this entry
      for (let c = 0; c < cutPoints.length; c++) {
        if (cutPoints[c] >= i) {
          cutIndex = cutPoints[c];
          break;
        }
      }
      break;
    }
  }

  // Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    // Stop at session header or compaction boundaries
    if (prevEntry.type === "compaction") {
      break;
    }
    if (prevEntry.type === "message") {
      // Stop if we hit any message
      break;
    }
    // Include this non-message entry (bash, settings change, etc.)
    cutIndex--;
  }

  // Determine if this is a split turn
  const cutEntry = entries[cutIndex];
  const isUserMessage =
    cutEntry.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage
    ? -1
    : findTurnStartIndex(entries, cutIndex, startIndex);

  return {
    firstKeptEntryIndex: cutIndex,
    isSplitTurn: !isUserMessage && turnStartIndex !== -1,
    turnStartIndex,
  };
}

/**
 * Find the user message that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 */
export function findTurnStartIndex(
  entries: SessionEntry[],
  entryIndex: number,
  startIndex: number,
): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    // branch_summary and custom_message are user-role messages, can start a turn
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      return i;
    }
    if (entry.type === "message") {
      const role = entry.message.role;
      if (role === "user") {
        return i;
      }
    }
  }
  return -1;
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(
  entries: SessionEntry[],
): undefined | Usage {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message") {
      const usage = getAssistantUsage(entry.message);
      if (usage) return usage;
    }
  }
  return undefined;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Find valid cut points: indices of user, assistant, custom, branchSummary, or compactionSummary messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 */
function findValidCutPoints(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    switch (entry.type) {
      case "branch_summary":
      case "compaction":
      case "custom":
      case "custom_message":
      case "label":
      case "model_change":
      case "session_info":
      case "thinking_level_change":
        break;
      case "message": {
        const role = entry.message.role;
        switch (role) {
          case "assistant":
          case "branchSummary":
          case "compactionSummary":
          case "custom":
          case "user":
            cutPoints.push(i);
            break;
          case "toolResult":
            break;
        }
        break;
      }
    }

    // branch_summary and custom_message are user-role messages, valid cut points
    if (entry.type === "branch_summary" || entry.type === "custom_message") {
      cutPoints.push(i);
    }
  }
  return cutPoints;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): undefined | Usage {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg as AssistantMessage;
    if (
      assistantMsg.stopReason !== "aborted" &&
      assistantMsg.stopReason !== "error" &&
      assistantMsg.usage
    ) {
      return assistantMsg.usage;
    }
  }
  return undefined;
}

function getLastAssistantUsageInfo(
  messages: AgentMessage[],
): { index: number; usage: Usage } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) return { index: i, usage };
  }
  return undefined;
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export interface CompactionPreparation {
  /** File operations extracted from messagesToSummarize */
  fileOps: FileOperations;
  /** UUID of first entry to keep */
  firstKeptEntryId: string;
  /** Whether this is a split turn (cut point in middle of turn) */
  isSplitTurn: boolean;
  /** Messages that will be summarized and discarded */
  messagesToSummarize: AgentMessage[];
  /** Summary from previous compaction, for iterative update */
  previousSummary?: string;
  /** Compaction settions from settings.jsonl	*/
  settings: CompactionSettings;
  tokensBefore: number;
  /** Messages that will be turned into turn prefix summary (if splitting) */
  turnPrefixMessages: AgentMessage[];
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
  currentMessages: AgentMessage[],
  model: Model<any>,
  reserveTokens: number,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);

  // Use update prompt if we have a previous summary, otherwise initial prompt
  let basePrompt = previousSummary
    ? UPDATE_SUMMARIZATION_PROMPT
    : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }

  // Serialize conversation to text so model doesn't try to continue it
  // Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);

  // Build the prompt with conversation wrapped in tags
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages = [
    {
      content: [{ text: promptText, type: "text" as const }],
      role: "user" as const,
      timestamp: Date.now(),
    },
  ];

  const completionOptions = model.reasoning
    ? { apiKey, headers, maxTokens, reasoning: "high" as const, signal }
    : { apiKey, headers, maxTokens, signal };

  const response = await completeSimple(
    model,
    {
      messages: summarizationMessages,
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    },
    completionOptions,
  );

  if (response.stopReason === "error") {
    throw new Error(
      `Summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }

  const textContent = response.content
    .filter((c): c is { text: string; type: "text" } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return textContent;
}

export function prepareCompaction(
  pathEntries: SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  if (
    pathEntries.length > 0 &&
    pathEntries[pathEntries.length - 1].type === "compaction"
  ) {
    return undefined;
  }

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
    const firstKeptEntryIndex = pathEntries.findIndex(
      (entry) => entry.id === prevCompaction.firstKeptEntryId,
    );
    boundaryStart =
      firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
  }
  const boundaryEnd = pathEntries.length;

  const tokensBefore = estimateContextTokens(
    buildSessionContext(pathEntries).messages,
  ).tokens;

  const cutPoint = findCutPoint(
    pathEntries,
    boundaryStart,
    boundaryEnd,
    settings.keepRecentTokens,
  );

  // Get UUID of first kept entry
  const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) {
    return undefined; // Session needs migration
  }
  const firstKeptEntryId = firstKeptEntry.id;

  const historyEnd = cutPoint.isSplitTurn
    ? cutPoint.turnStartIndex
    : cutPoint.firstKeptEntryIndex;

  // Messages to summarize (will be discarded after summary)
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i++) {
    const msg = getMessageFromEntryForCompaction(pathEntries[i]);
    if (msg) messagesToSummarize.push(msg);
  }

  // Messages for turn prefix summary (if splitting a turn)
  const turnPrefixMessages: AgentMessage[] = [];
  if (cutPoint.isSplitTurn) {
    for (
      let i = cutPoint.turnStartIndex;
      i < cutPoint.firstKeptEntryIndex;
      i++
    ) {
      const msg = getMessageFromEntryForCompaction(pathEntries[i]);
      if (msg) turnPrefixMessages.push(msg);
    }
  }

  // Extract file operations from messages and previous compaction
  const fileOps = extractFileOperations(
    messagesToSummarize,
    pathEntries,
    prevCompactionIndex,
  );

  // Also extract file ops from turn prefix if splitting
  if (cutPoint.isSplitTurn) {
    for (const msg of turnPrefixMessages) {
      extractFileOpsFromMessage(msg, fileOps);
    }
  }

  return {
    fileOps,
    firstKeptEntryId,
    isSplitTurn: cutPoint.isSplitTurn,
    messagesToSummarize,
    previousSummary,
    settings,
    tokensBefore,
    turnPrefixMessages,
  };
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
  preparation: CompactionPreparation,
  model: Model<any>,
  apiKey: string,
  headers?: Record<string, string>,
  customInstructions?: string,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  const {
    fileOps,
    firstKeptEntryId,
    isSplitTurn,
    messagesToSummarize,
    previousSummary,
    settings,
    tokensBefore,
    turnPrefixMessages,
  } = preparation;

  // Generate summaries (can be parallel if both needed) and merge into one
  let summary: string;

  if (isSplitTurn && turnPrefixMessages.length > 0) {
    // Generate both summaries in parallel
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(
            messagesToSummarize,
            model,
            settings.reserveTokens,
            apiKey,
            headers,
            signal,
            customInstructions,
            previousSummary,
          )
        : Promise.resolve("No prior history."),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        model,
        settings.reserveTokens,
        apiKey,
        headers,
        signal,
      ),
    ]);
    // Merge into single summary
    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    // Just generate history summary
    summary = await generateSummary(
      messagesToSummarize,
      model,
      settings.reserveTokens,
      apiKey,
      headers,
      signal,
      customInstructions,
      previousSummary,
    );
  }

  // Compute file lists and append to summary
  const { modifiedFiles, readFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  if (!firstKeptEntryId) {
    throw new Error(
      "First kept entry has no UUID - session may need migration",
    );
  }

  return {
    details: { modifiedFiles, readFiles } as CompactionDetails,
    firstKeptEntryId,
    summary,
    tokensBefore,
  };
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model<any>,
  reserveTokens: number,
  apiKey: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<string> {
  const maxTokens = Math.floor(0.5 * reserveTokens); // Smaller budget for turn prefix
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  const summarizationMessages = [
    {
      content: [{ text: promptText, type: "text" as const }],
      role: "user" as const,
      timestamp: Date.now(),
    },
  ];

  const response = await completeSimple(
    model,
    {
      messages: summarizationMessages,
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    },
    { apiKey, headers, maxTokens, signal },
  );

  if (response.stopReason === "error") {
    throw new Error(
      `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }

  return response.content
    .filter((c): c is { text: string; type: "text" } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
