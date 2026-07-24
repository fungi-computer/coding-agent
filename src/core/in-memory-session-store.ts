/**
 * InMemorySessionStore - For testing AgentSessionServer without persistence.
 */

import type { AgentMessage } from "@shiit/agent-core";

import { nanoid } from "@shiit/id";

import type { SessionEntry } from "./session-manager.js";
import type {
  SessionData,
  SessionListItem,
  SessionStore,
} from "./session-store.js";

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionData>();

  async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.entries.push(entry);
      session.modifiedAt = Date.now();
    }
  }

  async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push(message);
      session.modifiedAt = Date.now();
    }
  }

  clear(): void {
    this.sessions.clear();
  }

  async createSession(cwd: string): Promise<{ sessionId: string }> {
    const sessionId = nanoid();
    const now = Date.now();
    this.sessions.set(sessionId, {
      createdAt: now,
      cwd,
      entries: [],
      leafId: null,
      messages: [],
      modifiedAt: now,
      sessionId,
    });
    return { sessionId };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    return this.sessions.get(sessionId)?.entries ?? [];
  }

  async getMessages(sessionId: string): Promise<AgentMessage[]> {
    return this.sessions.get(sessionId)?.messages ?? [];
  }

  async getSession(sessionId: string): Promise<null | SessionData> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listSessions(): Promise<SessionListItem[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      createdAt: s.createdAt,
      cwd: s.cwd,
      id: s.sessionId,
      messageCount: s.messages.length,
      modifiedAt: s.modifiedAt,
      name: s.name,
      preview: s.entries
        .map((entry: any) => {
          if (entry.type !== "message") return undefined;
          const raw = entry.message?.content;
          if (typeof raw === "string")
            return raw.trim().slice(0, 200) || undefined;
          if (Array.isArray(raw)) {
            return (
              raw
                .filter(
                  (p: any) => p?.type === "text" && typeof p.text === "string",
                )
                .map((p: any) => p.text)
                .join(" ")
                .trim()
                .slice(0, 200) || undefined
            );
          }
          return undefined;
        })
        .find((p: any) => !!p),
    }));
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.name = name;
      session.modifiedAt = Date.now();
    }
  }

  async setLeaf(sessionId: string, leafId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.leafId = leafId;
      session.modifiedAt = Date.now();
    }
  }
}
