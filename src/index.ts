// Core session management

// Config paths
export { getAgentDir, VERSION } from "./config.js";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.js";
// Auth and model registry
export {
	type ApiKeyCredential,
	type AuthCredential,
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type OAuthCredential,
} from "./core/auth-storage.js";
// Compaction
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index.js";
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.js";
// Extension system
export type {
	AgentEndEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MessageRenderer,
	MessageRenderOptions,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandSource,
	SourceInfo,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WriteToolCallEvent,
} from "./core/extensions/index.js";
export {
	createExtensionRuntime,
	defineTool,
	discoverAndLoadExtensions,
	ExtensionRunner,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.js";
// Footer data provider (git branch + extension statuses - data not otherwise available to extensions)
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.js";
export { convertToLlm } from "./core/messages.js";
export { ModelRegistry } from "./core/model-registry.js";
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.js";
export { DefaultPackageManager } from "./core/package-manager.js";
export type { ResourceCollision, ResourceDiagnostic, ResourceLoader } from "./core/resource-loader.js";
export { DefaultResourceLoader } from "./core/resource-loader.js";
// SDK for programmatic usage
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	// Factory
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type PromptTemplate,
} from "./core/sdk.js";
export {
	type BranchSummaryEntry,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.js";
// AgentSessionServer types
export {
	type AgentSessionSyncEvent,
	type ClientMessage,
	type ServerMessage,
	type GlobalServerEvent,
	type SessionCommand,
	type SessionFactory,
	type SessionListItem,
	type SessionSnapshot,
} from "./core/agent-session-server-types.js";
export { AgentSessionServer } from "./core/agent-session-server.js";
export { AgentSessionClient, type ClientTransport } from "./core/agent-session-client.js";
export { WebSocketClientTransport } from "./core/websocket-client-transport.js";
export {
	type SessionStore,
} from "./core/session-store.js";
export {
	Transport,
	type Connection,
	type TransportFactory,
} from "./core/transport.js";
export {
	type CompactionSettings,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
} from "./core/settings-manager.js";
// Skills
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.js";
export { createSyntheticSourceInfo } from "./core/source-info.js";
// Run modes for programmatic SDK usage
export {
	type PrintModeOptions,
	runPrintMode,
	runRpcMode,
} from "./modes/index.js";
// Clipboard utilities
export { copyToClipboard } from "./utils/clipboard.js";
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.js";
// Shell utilities
export { getShellConfig } from "./utils/shell.js";
