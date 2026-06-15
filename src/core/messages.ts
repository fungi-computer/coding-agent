/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@shiit/agent-core";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface BranchSummaryMessage {
  fromId: string;
  role: "branchSummary";
  summary: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  timestamp: number;
  tokensBefore: number;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
  content: (ImageContent | TextContent)[] | string;
  customType: string;
  details?: T;
  display: boolean;
  role: "custom";
  timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@shiit/agent-core" {
  interface CustomAgentMessages {
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
    custom: CustomMessage;
  }
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case "assistant":
        case "toolResult":
        case "user":
          return m;
        case "branchSummary":
          return {
            content: [
              {
                text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX,
                type: "text" as const,
              },
            ],
            role: "user",
            timestamp: m.timestamp,
          };
        case "compactionSummary":
          return {
            content: [
              {
                text:
                  COMPACTION_SUMMARY_PREFIX +
                  m.summary +
                  COMPACTION_SUMMARY_SUFFIX,
                type: "text" as const,
              },
            ],
            role: "user",
            timestamp: m.timestamp,
          };
        case "custom": {
          const content =
            typeof m.content === "string"
              ? [{ text: m.content, type: "text" as const }]
              : m.content;
          return {
            content,
            role: "user",
            timestamp: m.timestamp,
          };
        }
        default:
          // biome-ignore lint/correctness/noSwitchDeclarations: fine
          const _exhaustiveCheck: never = m;
          return undefined;
      }
    })
    .filter((m) => m !== undefined);
}

export function createBranchSummaryMessage(
  summary: string,
  fromId: string,
  timestamp: string,
): BranchSummaryMessage {
  return {
    fromId,
    role: "branchSummary",
    summary,
    timestamp: new Date(timestamp).getTime(),
  };
}

export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  timestamp: string,
): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary: summary,
    timestamp: new Date(timestamp).getTime(),
    tokensBefore,
  };
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
  customType: string,
  content: (ImageContent | TextContent)[] | string,
  display: boolean,
  details: undefined | unknown,
  timestamp: string,
): CustomMessage {
  return {
    content,
    customType,
    details,
    display,
    role: "custom",
    timestamp: new Date(timestamp).getTime(),
  };
}
