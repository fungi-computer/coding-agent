/**
 * Extension system (stub for cloud deployment).
 * All exports use 'any' to allow compilation without full implementation.
 */

// Type exports
export type ExtensionRunner = any;
export type SessionStartEvent = any;
export type LoadExtensionsResult = any;
export type ExtensionRuntime = any;
export type ExtensionFactory = any;
export type Extension = any;
export type ExtensionContext = any;
export type ExtensionAPI = any;
export type ExtensionEvent = any;
export type ToolDefinition = any;
export type AgentToolResult = any;
export type AgentToolUpdateCallback = any;
export type AgentStartEvent = any;
export type AgentEndEvent = any;
export type TurnStartEvent = any;
export type TurnEndEvent = any;
export type ToolCallEvent = any;
export type ToolResultEvent = any;
export type MessageStartEvent = any;
export type MessageUpdateEvent = any;
export type MessageEndEvent = any;
export type SessionShutdownEvent = any;
export type SessionCompactEvent = any;
export type SessionBeforeCompactEvent = any;
export type SessionBeforeCompactResult = any;
export type ContextEvent = any;
export type ContextEventResult = any;
export type BeforeAgentStartEvent = any;
export type BeforeAgentStartEventResult = any;
export type BeforeProviderRequestEvent = any;
export type BeforeProviderRequestEventResult = any;
export type ExtensionHandler = any;
export type ToolCallEventResult = any;
export type ToolResultEventResult = any;
export type SessionBeforeSwitchEvent = any;
export type SessionBeforeSwitchResult = any;
export type SessionBeforeForkEvent = any;
export type SessionBeforeForkResult = any;
export type SessionBeforeTreeEvent = any;
export type SessionBeforeTreeResult = any;
export type SessionTreeEvent = any;
export type InputEvent = any;
export type InputEventResult = any;
export type UserBashEvent = any;
export type UserBashEventResult = any;
export type ToolExecutionStartEvent = any;
export type ToolExecutionUpdateEvent = any;
export type ToolExecutionEndEvent = any;
export type ModelSelectEvent = any;
export type ExtensionError = any;
export type ExtensionErrorListener = any;
export type ShutdownHandler = any;
export type ExtensionCommandContext = any;
export type RegisteredCommand = any;
export type ExtensionShortcut = any;
export type ExtensionFlag = any;
export type ExtensionUIContext = any;
export type MessageRenderer = any;
export type ToolRenderResultOptions = any;
export type ExecOptions = any;
export type ExecResult = any;
export type InputSource = any;
export type ContextUsage = any;
export type ToolInfo = any;
export type TreePreparation = any;
export type ExtensionCommandContextActions = any;
export type AppKeybinding = any;
export type BashToolCallEvent = any;
export type CompactOptions = any;
export type CustomToolCallEvent = any;
export type EditToolCallEvent = any;
export type ExtensionActions = any;
export type ExtensionContextActions = any;
export type ExtensionUIDialogOptions = any;
export type ExtensionWidgetOptions = any;
export type FindToolCallEvent = any;
export type GrepToolCallEvent = any;
export type KeybindingsManager = any;
export type LsToolCallEvent = any;
export type MessageRenderOptions = any;
export type ProviderConfig = any;
export type ProviderModelConfig = any;
export type ReadToolCallEvent = any;
export type RegisteredTool = any;
export type ResourceCollision = any;
export type ResourceDiagnostic = any;
export type SessionBeforeCompactEventResult = any;
export type SessionBeforeSwitchEventResult = any;
export type SessionCompactEventResult = any;
export type SessionEndEvent = any;
export type SessionEntry = any;
export type SessionForkEvent = any;
export type SessionInfo = any;
export type SessionPersistEvent = any;
export type SessionResumeEvent = any;
export type SessionStartEventResult = any;
export type SessionSwitchEvent = any;
export type SlashCommandInfo = any;
export type SlashCommandSource = any;
export type ToolRenderContext = any;
export type WriteToolCallEvent = any;
export type AppMode = any;
export type AssistantMessage = any;
export type CustomMessage = any;
export type PendingToolCall = any;
export type SessionStartOrigin = any;
export type ResolvedCommand = any;
export type SourceInfo = any;
export type TerminalInputHandler = any;
export type WidgetPlacement = any;
export type isBashToolResult = any;
export type isEditToolResult = any;
export type isFindToolResult = any;
export type isGrepToolResult = any;
export type isLsToolResult = any;
export type isReadToolResult = any;
export type isToolCallEventType = any;
export type isWriteToolResult = any;
export type wrapRegisteredTool = any;

// Function exports
export const defineTool = (tool: any) => tool;
export const createExtensionRuntime = () => ({});
export const loadExtensions = (_paths?: any, _cwd?: any) => ({
	extensions: [] as any[],
	errors: [] as Array<{ path: string; error: string }>,
	runtime: createExtensionRuntime()
});
export const loadExtensionFromFactory = (_factory?: any, _cwd?: any, _runtime?: any, _extensionPath?: any) => undefined;
export const emitSessionShutdownEvent = (_runner: any) => Promise.resolve(false);
export function wrapRegisteredTools(registeredTools: any[], _runner: any): any[] {
	return registeredTools.map((tool) => {
		if (tool.definition?.invoke) {
			const def = tool.definition;
			return {
				name: def.name,
				label: def.label ?? def.name,
				description: def.description,
				parameters: def.parameters,
				prepareArguments: def.prepareArguments,
				execute: async (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any) => {
					const result = await def.invoke(params, { toolCallId, signal, onUpdate });
					const content = typeof result === "string" ? [{ type: "text" as const, text: result }] : result;
					return { content, details: {} };
				},
			};
		}
		if (tool.definition?.execute) {
			return {
				name: tool.definition.name,
				label: tool.definition.label ?? tool.definition.name,
				description: tool.definition.description,
				parameters: tool.definition.parameters,
				prepareArguments: tool.definition.prepareArguments,
				execute: tool.definition.execute,
			};
		}
		return {
			name: tool.definition?.name,
			label: tool.definition?.label ?? tool.definition?.name,
			description: tool.definition?.description,
			parameters: tool.definition?.parameters,
			execute: tool.definition?.execute,
		};
	});
}
export const discoverAndLoadExtensions = () => ({ extensions: [], errors: [] });

// ExtensionRunner as both type and value
export const ExtensionRunner = class {
	constructor(
		_extensions?: unknown[],
		_runtime?: unknown,
		_cwd?: string,
		_sessionManager?: unknown,
		_modelRegistry?: unknown,
	) {}

	bindCore(_core: any) {
		// Stub - extensions not supported in cloud deployment
	}

	bindCommandContext(_context: any) {
		// Stub - extensions not supported in cloud deployment
	}

	emit(_event: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve();
	}

	emitError(_error: any) {
		// Stub - extensions not supported in cloud deployment
	}

	emitToolCall(_toolCall: any, _context: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve({ content: [] });
	}

	emitToolResult(_result: any, _context: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve();
	}

	emitBeforeProviderRequest(_payload: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve({ skip: false });
	}

	emitContext(_messages: any) {
		return Promise.resolve(_messages);
	}

	emitInput(_input: any, _context: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve({ content: "" });
	}

	emitBeforeAgentStart(_event: any, _context: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve({ skip: false });
	}

	emitResourcesDiscover(_cwd: any, _runtime: any) {
		// Stub - extensions not supported in cloud deployment
		return Promise.resolve({ skillPaths: [], promptPaths: [], themePaths: [] });
	}

	dispose() {
		// Stub - extensions not supported in cloud deployment
	}

	setUIContext(_context: any) {
		// Stub - extensions not supported in cloud deployment
	}

	hasHandlers(_eventType: string): boolean {
		// Stub - extensions not supported in cloud deployment
		return false;
	}

	getFlagValues(): Map<string, boolean | string> {
		// Stub - extensions not supported in cloud deployment
		return new Map();
	}

	onError(_listener: any) {
		// Stub - extensions not supported in cloud deployment
	}

	getRegisteredCommands(): any[] {
		// Stub - extensions not supported in cloud deployment
		return [];
	}

	getCommand(_name: string) {
		// Stub - extensions not supported in cloud deployment
		return undefined;
	}

	createCommandContext() {
		// Stub - extensions not supported in cloud deployment
		return {};
	}

	getAllRegisteredTools(): any[] {
		// Stub - extensions not supported in cloud deployment
		return [];
	}
} as any;
