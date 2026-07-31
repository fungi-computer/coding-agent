/**
 * SessionStore - Persistence abstraction for AgentSessionServer.
 *
 * Implementations handle how sessions are persisted (SQLite, file system, etc.)
 */

import type { AgentMessage } from "@shiit/agent-core";

import type { SessionEntry } from "./session-manager.js";

export interface SessionData {
  createdAt: number;
  cwd: string;
  entries: SessionEntry[];
  leafId: null | string;
  messages: AgentMessage[];
  modifiedAt: number;
  name?: string;
  preview?: string;
  sessionId: string;
}

export interface SessionListItem {
  createdAt: number;
  cwd: string;
  id: string;
  messageCount: number;
  modifiedAt: number;
  name?: string;
  preview?: string;
}

export interface SessionStore {
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  appendMessage(sessionId: string, message: AgentMessage): Promise<void>;
  createSession(cwd: string): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string): Promise<void>;
  getEntries(sessionId: string): Promise<SessionEntry[]>;

  getMessages(sessionId: string, limit?: number): Promise<AgentMessage[]>;
  getSession(sessionId: string): Promise<null | SessionData>;

  listSessions(): Promise<SessionListItem[]>;
  renameSession(sessionId: string, name: string): Promise<void>;

  setLeaf(sessionId: string, leafId: string): Promise<void>;
}
