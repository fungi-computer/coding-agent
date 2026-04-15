/**
 * InMemorySessionStore - For testing AgentSessionServer without persistence.
 */

import type { AgentMessage } from "@shiit/agent-core";
import { nanoid } from "@shiit/id";
import type { SessionEntry } from "./session-manager.js";
import type { SessionStore, SessionListItem, SessionData } from "./session-store.js";

export class InMemorySessionStore implements SessionStore {
	private sessions: Map<string, SessionData> = new Map();

	async createSession(cwd: string): Promise<{ sessionId: string }> {
		const sessionId = nanoid();
		const now = Date.now();
		this.sessions.set(sessionId, {
			sessionId,
			cwd,
			createdAt: now,
			modifiedAt: now,
			leafId: null,
			entries: [],
			messages: [],
		});
		return { sessionId };
	}

	async getSession(sessionId: string): Promise<SessionData | null> {
		return this.sessions.get(sessionId) ?? null;
	}

	async deleteSession(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
	}

	async listSessions(): Promise<SessionListItem[]> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.sessionId,
			name: s.name,
			cwd: s.cwd,
			createdAt: s.createdAt,
			modifiedAt: s.modifiedAt,
			messageCount: s.messages.length,
		}));
	}

	async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.entries.push(entry);
			session.modifiedAt = Date.now();
		}
	}

	async getEntries(sessionId: string): Promise<SessionEntry[]> {
		return this.sessions.get(sessionId)?.entries ?? [];
	}

	async appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.messages.push(message);
			session.modifiedAt = Date.now();
		}
	}

	async getMessages(sessionId: string): Promise<AgentMessage[]> {
		return this.sessions.get(sessionId)?.messages ?? [];
	}

	async setLeaf(sessionId: string, leafId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.leafId = leafId;
			session.modifiedAt = Date.now();
		}
	}

	clear(): void {
		this.sessions.clear();
	}
}
