/**
 * ToolBackend - Tool execution abstraction for AgentSessionServer.
 *
 * Implementations provide the tools available to sessions (file tools, bash, etc.)
 */

import type { BashResult } from "./bash-executor.js";

export interface BashOptions {
	 cwd?: string;
	 timeout?: number;
	 excludeFromContext?: boolean;
}

export interface ToolResult {
	content: unknown;
	isError?: boolean;
}

export interface ToolBackend {
	readonly tools: ToolDefinition[];
	executeTool(name: string, args: unknown): Promise<ToolResult>;
	executeBash(command: string, options?: BashOptions): Promise<BashResult>;
	executeBashStreaming(
		command: string,
		options: BashOptions,
		onChunk: (chunk: string) => void,
	): Promise<BashResult>;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	parameters?: unknown;
}
