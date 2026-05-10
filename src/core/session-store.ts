/**
 * SessionStore - Persistence abstraction for AgentSessionServer.
 *
 * Implementations handle how sessions are persisted (SQLite, file system, etc.)
 */

import type { AgentMessage } from "@shiit/agent-core";
import type { SessionEntry } from "./session-manager.js";

export interface SessionListItem {
  id: string;
  name?: string;
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
}

export interface SessionData {
  sessionId: string;
  cwd: string;
  name?: string;
  createdAt: number;
  modifiedAt: number;
  leafId: string | null;
  entries: SessionEntry[];
  messages: AgentMessage[];
}

export interface SessionStore {
  createSession(cwd: string): Promise<{ sessionId: string }>;
  getSession(sessionId: string): Promise<SessionData | null>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(): Promise<SessionListItem[]>;
  renameSession(sessionId: string, name: string): Promise<void>;

  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  getEntries(sessionId: string): Promise<SessionEntry[]>;

  appendMessage(sessionId: string, message: AgentMessage): Promise<void>;
  getMessages(sessionId: string): Promise<AgentMessage[]>;

  setLeaf(sessionId: string, leafId: string): Promise<void>;
}
