/**
 * Bash execution stub for cloud environment.
 *
 * In pi-mono this provided local bash execution. For our fork,
 * bash execution is provided by the environment (e.g., cloudflare-workspace)
 * via tools, not by this module.
 */

export interface BashExecutorOptions {
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export function executeBash(_command: string, _options?: BashExecutorOptions): Promise<BashResult> {
	throw new Error("executeBash is not supported in cloud environment. Use tools instead.");
}

export async function executeBashWithOperations(
	_command: string,
	_cwd: string,
	_operations: unknown,
	_options?: BashExecutorOptions,
): Promise<BashResult> {
	throw new Error("executeBashWithOperations is not supported in cloud environment. Use tools instead.");
}
