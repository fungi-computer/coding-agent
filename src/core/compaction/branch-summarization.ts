/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@shiit/agent-core";

import { completeSimple } from "@mariozechner/pi-ai";

import type {
  ReadonlySessionManager,
  SessionEntry,
} from "../session-manager.js";

import {
  convertToLlm,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  createCustomMessage,
} from "../messages.js";
import { estimateTokens } from "./compaction.js";
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
// Types
// ============================================================================

export interface BranchPreparation {
  /** File operations extracted from tool calls */
  fileOps: FileOperations;
  /** Messages extracted for summarization, in chronological order */
  messages: AgentMessage[];
  /** Total estimated tokens in messages */
  totalTokens: number;
}

/** Details stored in BranchSummaryEntry.details for file tracking */
export interface BranchSummaryDetails {
  modifiedFiles: string[];
  readFiles: string[];
}

export type { FileOperations } from "./utils.js";

export interface BranchSummaryResult {
  aborted?: boolean;
  error?: string;
  modifiedFiles?: string[];
  readFiles?: string[];
  summary?: string;
}

export interface CollectEntriesResult {
  /** Common ancestor between old and new position, if any */
  commonAncestorId: null | string;
  /** Entries to summarize, in chronological order */
  entries: SessionEntry[];
}

export interface GenerateBranchSummaryOptions {
  /** API key for the model */
  apiKey: string;
  /** Optional custom instructions for summarization */
  customInstructions?: string;
  /** Request headers for the model */
  headers?: Record<string, string>;
  /** Model to use for summarization */
  model: Model<any>;
  /** If true, customInstructions replaces the default prompt instead of being appended */
  replaceInstructions?: boolean;
  /** Tokens reserved for prompt + LLM response (default 16384) */
  reserveTokens?: number;
  /** Abort signal for cancellation */
  signal: AbortSignal;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
  session: ReadonlySessionManager,
  oldLeafId: null | string,
  targetId: string,
): CollectEntriesResult {
  // If no old position, nothing to summarize
  if (!oldLeafId) {
    return { commonAncestorId: null, entries: [] };
  }

  // Find common ancestor (deepest node that's on both paths)
  const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
  const targetPath = session.getBranch(targetId);

  // targetPath is root-first, so iterate backwards to find deepest common ancestor
  let commonAncestorId: null | string = null;
  for (let i = targetPath.length - 1; i >= 0; i--) {
    if (oldPath.has(targetPath[i].id)) {
      commonAncestorId = targetPath[i].id;
      break;
    }
  }

  // Collect entries from old leaf back to common ancestor
  const entries: SessionEntry[] = [];
  let current: null | string = oldLeafId;

  while (current && current !== commonAncestorId) {
    const entry = session.getEntry(current);
    if (!entry) break;
    entries.push(entry);
    current = entry.parentId;
  }

  // Reverse to get chronological order
  entries.reverse();

  return { commonAncestorId, entries };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(
  entries: SessionEntry[],
  tokenBudget = 0,
): BranchPreparation {
  const messages: AgentMessage[] = [];
  const fileOps = createFileOps();
  let totalTokens = 0;

  // First pass: collect file ops from ALL entries (even if they don't fit in token budget)
  // This ensures we capture cumulative file tracking from nested branch summaries
  // Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
  for (const entry of entries) {
    if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
      const details = entry.details as BranchSummaryDetails;
      if (Array.isArray(details.readFiles)) {
        for (const f of details.readFiles) fileOps.read.add(f);
      }
      if (Array.isArray(details.modifiedFiles)) {
        // Modified files go into both edited and written for proper deduplication
        for (const f of details.modifiedFiles) {
          fileOps.edited.add(f);
        }
      }
    }
  }

  // Second pass: walk from newest to oldest, adding messages until token budget
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const message = getMessageFromEntry(entry);
    if (!message) continue;

    // Extract file ops from assistant messages (tool calls)
    extractFileOpsFromMessage(message, fileOps);

    const tokens = estimateTokens(message);

    // Check budget before adding
    if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
      // If this is a summary entry, try to fit it anyway as it's important context
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        if (totalTokens < tokenBudget * 0.9) {
          messages.unshift(message);
          totalTokens += tokens;
        }
      }
      // Stop - we've hit the budget
      break;
    }

    messages.unshift(message);
    totalTokens += tokens;
  }

  return { fileOps, messages, totalTokens };
}

/**
 * Extract AgentMessage from a session entry.
 * Similar to getMessageFromEntry in compaction.ts but also handles compaction entries.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  switch (entry.type) {
    case "branch_summary":
      return createBranchSummaryMessage(
        entry.summary,
        entry.fromId,
        entry.timestamp,
      );

    case "compaction":
      return createCompactionSummaryMessage(
        entry.summary,
        entry.tokensBefore,
        entry.timestamp,
      );

    // These don't contribute to conversation content
    case "custom":

    case "label":

    case "model_change":
    case "session_info":
    case "thinking_level_change":
      return undefined;
    case "custom_message":
      return createCustomMessage(
        entry.customType,
        entry.content,
        entry.display,
        entry.details,
        entry.timestamp,
      );
    case "message":
      // Skip tool results - context is in assistant's tool call
      if (entry.message.role === "toolResult") return undefined;
      return entry.message;
  }
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
  const {
    apiKey,
    customInstructions,
    headers,
    model,
    replaceInstructions,
    reserveTokens = 16384,
    signal,
  } = options;

  // Token budget = context window minus reserved space for prompt + response
  const contextWindow = model.contextWindow || 128000;
  const tokenBudget = contextWindow - reserveTokens;

  const { fileOps, messages } = prepareBranchEntries(entries, tokenBudget);

  if (messages.length === 0) {
    return { summary: "No content to summarize" };
  }

  // Transform to LLM-compatible messages, then serialize to text
  // Serialization prevents the model from treating it as a conversation to continue
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);

  // Build prompt
  let instructions: string;
  if (replaceInstructions && customInstructions) {
    instructions = customInstructions;
  } else if (customInstructions) {
    instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
  } else {
    instructions = BRANCH_SUMMARY_PROMPT;
  }
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

  const summarizationMessages = [
    {
      content: [{ text: promptText, type: "text" as const }],
      role: "user" as const,
      timestamp: Date.now(),
    },
  ];

  // Call LLM for summarization
  const response = await completeSimple(
    model,
    {
      messages: summarizationMessages,
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    },
    { apiKey, headers, maxTokens: 2048, signal },
  );

  // Check if aborted or errored
  if (response.stopReason === "aborted") {
    return { aborted: true };
  }
  if (response.stopReason === "error") {
    return { error: response.errorMessage || "Summarization failed" };
  }

  let summary = response.content
    .filter((c): c is { text: string; type: "text"; } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // Prepend preamble to provide context about the branch summary
  summary = BRANCH_SUMMARY_PREAMBLE + summary;

  // Compute file lists and append to summary
  const { modifiedFiles, readFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  return {
    modifiedFiles,
    readFiles,
    summary: summary || "No summary generated",
  };
}
