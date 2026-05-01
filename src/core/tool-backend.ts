/**
 * ToolMount - Tool execution abstraction for AgentSessionServer.
 *
 * A mount owns the tools available to sessions. The agent loop asks the mount
 * what's available (listTools) and asks it to execute (execute). The mount
 * decides what tools exist based on the environment.
 */

export interface ToolMount {
	/** List available tools on this mount */
	listTools(): ToolDefinition[];

	/**
	 * Execute a tool by name on this mount.
	 *
	 * @param name - Tool name
	 * @param args - Tool arguments (validated against tool schema)
	 * @param signal - Abort signal for cancellation
	 * @param onUpdate - Callback for streaming partial results
	 */
	execute(
		name: string,
		args: unknown,
		signal?: AbortSignal,
		onUpdate?: ToolUpdateCallback,
	): Promise<ToolResult>;
}

export type ToolUpdateCallback = (partialResult: ToolResult) => void;

export interface ToolResult {
	content: unknown;
	isError?: boolean;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	parameters?: unknown;
}
