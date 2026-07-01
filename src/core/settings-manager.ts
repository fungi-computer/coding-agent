import type { Transport } from "@earendil-works/pi-ai";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";

export interface BranchSummarySettings {
  reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
  skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface CompactionSettings {
  enabled?: boolean; // default: true
  keepRecentTokens?: number; // default: 20000
  reserveTokens?: number; // default: 16384
}

export interface ImageSettings {
  autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
  blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface MarkdownSettings {
  codeBlockIndent?: string; // default: "  "
}

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
  | {
      extensions?: string[];
      prompts?: string[];
      skills?: string[];
      source: string;
      themes?: string[];
    }
  | string;

export interface RetrySettings {
  baseDelayMs?: number; // default: 3000 (exponential backoff: 3s, 6s, 12s, 24s, 48s, then capped at maxDelayMs)
  enabled?: boolean; // default: true
  maxDelayMs?: number; // default: 60000 (max server-requested delay before failing)
  maxRetries?: number; // default: 10 (5 exponential backoff retries + 5 capped at maxDelayMs ≈ 6.5 min total)
  provider?: {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    timeoutMs?: number;
  };
}

export interface Settings {
  autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
  branchSummary?: BranchSummarySettings;
  collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
  compaction?: CompactionSettings;
  defaultModel?: string;
  defaultProvider?: string;
  defaultThinkingLevel?:
    | "high"
    | "low"
    | "medium"
    | "minimal"
    | "off"
    | "xhigh";
  doubleEscapeAction?: "fork" | "none" | "tree"; // Action for double-escape with empty editor (default: "tree")
  editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
  enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
  enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
  extensions?: string[]; // Array of local extension file paths or directories
  followUpMode?: "all" | "one-at-a-time";
  hideThinkingBlock?: boolean;
  images?: ImageSettings;
  lastChangelogVersion?: string;
  markdown?: MarkdownSettings;
  npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
  packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
  prompts?: string[]; // Array of local prompt template paths or directories
  quietStartup?: boolean;
  retry?: RetrySettings;
  sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
  shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
  shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
  showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
  skills?: string[]; // Array of local skill file paths or directories
  steeringMode?: "all" | "one-at-a-time";
  terminal?: TerminalSettings;
  theme?: string;
  themes?: string[]; // Array of local theme file paths or directories
  thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
  transport?: TransportSetting; // default: "sse"
  treeFilterMode?:
    | "all" // Default filter when opening /tree
    | "default"
    | "labeled-only"
    | "no-tools"
    | "user-only";
}

export interface SettingsError {
  error: Error;
  scope: SettingsScope;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
  withLock(
    scope: SettingsScope,
    fn: (current: string | undefined) => string | undefined,
  ): void;
}

export interface TerminalSettings {
  clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
  showImages?: boolean; // default: true (only relevant if terminal supports images)
}

export interface ThinkingBudgetsSettings {
  high?: number;
  low?: number;
  medium?: number;
  minimal?: number;
}

export type TransportSetting = Transport;

export class FileSettingsStorage implements SettingsStorage {
  private globalSettingsPath: string;
  private projectSettingsPath: string;

  constructor(cwd: string = process.cwd(), agentDir: string = getAgentDir()) {
    this.globalSettingsPath = join(agentDir, "settings.json");
    this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
  }

  withLock(
    scope: SettingsScope,
    fn: (current: string | undefined) => string | undefined,
  ): void {
    const path =
      scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
    const dir = dirname(path);

    let release: (() => void) | undefined;
    try {
      // Only create directory and lock if file exists or we need to write
      const fileExists = existsSync(path);
      if (fileExists) {
        release = this.acquireLockSyncWithRetry(path);
      }
      const current = fileExists ? readFileSync(path, "utf-8") : undefined;
      const next = fn(current);
      if (next !== undefined) {
        // Only create directory when we actually need to write
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        if (!release) {
          release = this.acquireLockSyncWithRetry(path);
        }
        writeFileSync(path, next, "utf-8");
      }
    } finally {
      if (release) {
        release();
      }
    }
  }

  private acquireLockSyncWithRetry(path: string): () => void {
    const maxAttempts = 10;
    const delayMs = 20;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return lockfile.lockSync(path, { realpath: false });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED" || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // Sleep synchronously to avoid changing callers to async.
        }
      }
    }

    throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
  }
}

export class InMemorySettingsStorage implements SettingsStorage {
  private global: string | undefined;
  private project: string | undefined;

  withLock(
    scope: SettingsScope,
    fn: (current: string | undefined) => string | undefined,
  ): void {
    const current = scope === "global" ? this.global : this.project;
    const next = fn(current);
    if (next !== undefined) {
      if (scope === "global") {
        this.global = next;
      } else {
        this.project = next;
      }
    }
  }
}

export class SettingsManager {
  private errors: SettingsError[];
  private globalSettings: Settings;
  private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
  private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
  private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
  private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
  private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
  private projectSettings: Settings;
  private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
  private settings: Settings;
  private storage: SettingsStorage;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    storage: SettingsStorage,
    initialGlobal: Settings,
    initialProject: Settings,
    globalLoadError: Error | null = null,
    projectLoadError: Error | null = null,
    initialErrors: SettingsError[] = [],
  ) {
    this.storage = storage;
    this.globalSettings = initialGlobal;
    this.projectSettings = initialProject;
    this.globalSettingsLoadError = globalLoadError;
    this.projectSettingsLoadError = projectLoadError;
    this.errors = [...initialErrors];
    this.settings = deepMergeSettings(
      this.globalSettings,
      this.projectSettings,
    );
  }

  /** Create a SettingsManager that loads from files */
  static create(
    cwd: string = process.cwd(),
    agentDir: string = getAgentDir(),
  ): SettingsManager {
    const storage = new FileSettingsStorage(cwd, agentDir);
    return SettingsManager.fromStorage(storage);
  }

  /** Create a SettingsManager from an arbitrary storage backend */
  static fromStorage(storage: SettingsStorage): SettingsManager {
    const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
    const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
    const initialErrors: SettingsError[] = [];
    if (globalLoad.error) {
      initialErrors.push({ error: globalLoad.error, scope: "global" });
    }
    if (projectLoad.error) {
      initialErrors.push({ error: projectLoad.error, scope: "project" });
    }

    return new SettingsManager(
      storage,
      globalLoad.settings,
      projectLoad.settings,
      globalLoad.error,
      projectLoad.error,
      initialErrors,
    );
  }

  /** Create an in-memory SettingsManager (no file I/O) */
  static inMemory(settings: Partial<Settings> = {}): SettingsManager {
    const storage = new InMemorySettingsStorage();
    return new SettingsManager(storage, settings, {});
  }

  private static loadFromStorage(
    storage: SettingsStorage,
    scope: SettingsScope,
  ): Settings {
    let content: string | undefined;
    storage.withLock(scope, (current) => {
      content = current;
      return undefined;
    });

    if (!content) {
      return {};
    }
    const settings = JSON.parse(content);
    return SettingsManager.migrateSettings(settings);
  }

  /** Migrate old settings format to new format */
  private static migrateSettings(settings: Record<string, unknown>): Settings {
    // Migrate queueMode -> steeringMode
    if ("queueMode" in settings && !("steeringMode" in settings)) {
      settings.steeringMode = settings.queueMode;
      delete settings.queueMode;
    }

    // Migrate legacy websockets boolean -> transport enum
    if (
      !("transport" in settings) &&
      typeof settings.websockets === "boolean"
    ) {
      settings.transport = settings.websockets ? "websocket" : "sse";
      delete settings.websockets;
    }

    // Migrate old skills object format to new array format
    if (
      "skills" in settings &&
      typeof settings.skills === "object" &&
      settings.skills !== null &&
      !Array.isArray(settings.skills)
    ) {
      const skillsSettings = settings.skills as {
        customDirectories?: unknown;
        enableSkillCommands?: boolean;
      };
      if (
        skillsSettings.enableSkillCommands !== undefined &&
        settings.enableSkillCommands === undefined
      ) {
        settings.enableSkillCommands = skillsSettings.enableSkillCommands;
      }
      if (
        Array.isArray(skillsSettings.customDirectories) &&
        skillsSettings.customDirectories.length > 0
      ) {
        settings.skills = skillsSettings.customDirectories;
      } else {
        delete settings.skills;
      }
    }

    return settings as Settings;
  }

  private static tryLoadFromStorage(
    storage: SettingsStorage,
    scope: SettingsScope,
  ): { error: Error | null; settings: Settings } {
    try {
      return {
        error: null,
        settings: SettingsManager.loadFromStorage(storage, scope),
      };
    } catch (error) {
      return { error: error as Error, settings: {} };
    }
  }

  /** Apply additional overrides on top of current settings */
  applyOverrides(overrides: Partial<Settings>): void {
    this.settings = deepMergeSettings(this.settings, overrides);
  }

  drainErrors(): SettingsError[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  getAutocompleteMaxVisible(): number {
    return this.settings.autocompleteMaxVisible ?? 5;
  }

  getBlockImages(): boolean {
    return this.settings.images?.blockImages ?? false;
  }

  getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
    return {
      reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
      skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
    };
  }

  getBranchSummarySkipPrompt(): boolean {
    return this.settings.branchSummary?.skipPrompt ?? false;
  }

  getClearOnShrink(): boolean {
    // Settings takes precedence, then env var, then default false
    if (this.settings.terminal?.clearOnShrink !== undefined) {
      return this.settings.terminal.clearOnShrink;
    }
    return process.env.PI_CLEAR_ON_SHRINK === "1";
  }

  getCodeBlockIndent(): string {
    return this.settings.markdown?.codeBlockIndent ?? "  ";
  }

  getCollapseChangelog(): boolean {
    return this.settings.collapseChangelog ?? false;
  }

  getCompactionEnabled(): boolean {
    return this.settings.compaction?.enabled ?? true;
  }

  getCompactionKeepRecentTokens(): number {
    return this.settings.compaction?.keepRecentTokens ?? 20000;
  }

  getCompactionReserveTokens(): number {
    return this.settings.compaction?.reserveTokens ?? 16384;
  }

  getCompactionSettings(): {
    enabled: boolean;
    keepRecentTokens: number;
    reserveTokens: number;
  } {
    return {
      enabled: this.getCompactionEnabled(),
      keepRecentTokens: this.getCompactionKeepRecentTokens(),
      reserveTokens: this.getCompactionReserveTokens(),
    };
  }

  getDefaultModel(): string | undefined {
    return this.settings.defaultModel;
  }

  getDefaultProvider(): string | undefined {
    return this.settings.defaultProvider;
  }

  getDefaultThinkingLevel():
    | "high"
    | "low"
    | "medium"
    | "minimal"
    | "off"
    | "xhigh"
    | undefined {
    return this.settings.defaultThinkingLevel;
  }

  getDoubleEscapeAction(): "fork" | "none" | "tree" {
    return this.settings.doubleEscapeAction ?? "tree";
  }

  getEditorPaddingX(): number {
    return this.settings.editorPaddingX ?? 0;
  }

  getEnabledModels(): string[] | undefined {
    return this.settings.enabledModels;
  }

  getEnableSkillCommands(): boolean {
    return this.settings.enableSkillCommands ?? true;
  }

  getExtensionPaths(): string[] {
    return [...(this.settings.extensions ?? [])];
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode || "one-at-a-time";
  }

  getGlobalSettings(): Settings {
    return structuredClone(this.globalSettings);
  }

  getHideThinkingBlock(): boolean {
    return this.settings.hideThinkingBlock ?? false;
  }

  getImageAutoResize(): boolean {
    return this.settings.images?.autoResize ?? true;
  }

  getLastChangelogVersion(): string | undefined {
    return this.settings.lastChangelogVersion;
  }

  getNpmCommand(): string[] | undefined {
    return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
  }

  getPackages(): PackageSource[] {
    return [...(this.settings.packages ?? [])];
  }

  getProjectSettings(): Settings {
    return structuredClone(this.projectSettings);
  }

  getPromptTemplatePaths(): string[] {
    return [...(this.settings.prompts ?? [])];
  }

  getQuietStartup(): boolean {
    return this.settings.quietStartup ?? false;
  }

  getRetryEnabled(): boolean {
    return this.settings.retry?.enabled ?? true;
  }

  getRetrySettings(): {
    baseDelayMs: number;
    enabled: boolean;
    maxDelayMs: number;
    maxRetries: number;
  } {
    return {
      baseDelayMs: this.settings.retry?.baseDelayMs ?? 3000,
      enabled: this.getRetryEnabled(),
      maxDelayMs: this.settings.retry?.maxDelayMs ?? 60000,
      maxRetries: this.settings.retry?.maxRetries ?? 10,
    };
  }

  getProviderRetrySettings(): {
    maxRetries?: number;
    maxRetryDelayMs?: number;
    timeoutMs?: number;
  } {
    return {
      maxRetries: this.settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs,
      timeoutMs: this.settings.retry?.provider?.timeoutMs,
    };
  }

  getSessionDir(): string | undefined {
    return this.settings.sessionDir;
  }

  getShellCommandPrefix(): string | undefined {
    return this.settings.shellCommandPrefix;
  }

  getShellPath(): string | undefined {
    return this.settings.shellPath;
  }

  getShowHardwareCursor(): boolean {
    return (
      this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1"
    );
  }

  getShowImages(): boolean {
    return this.settings.terminal?.showImages ?? true;
  }

  getSkillPaths(): string[] {
    return [...(this.settings.skills ?? [])];
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode || "one-at-a-time";
  }

  getTheme(): string | undefined {
    return this.settings.theme;
  }

  getThemePaths(): string[] {
    return [...(this.settings.themes ?? [])];
  }

  getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
    return this.settings.thinkingBudgets;
  }

  getTransport(): TransportSetting {
    return this.settings.transport ?? "sse";
  }

  getTreeFilterMode():
    | "all"
    | "default"
    | "labeled-only"
    | "no-tools"
    | "user-only" {
    const mode = this.settings.treeFilterMode;
    const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
    return mode && valid.includes(mode) ? mode : "default";
  }

  async reload(): Promise<void> {
    await this.writeQueue;
    const globalLoad = SettingsManager.tryLoadFromStorage(
      this.storage,
      "global",
    );
    if (!globalLoad.error) {
      this.globalSettings = globalLoad.settings;
      this.globalSettingsLoadError = null;
    } else {
      this.globalSettingsLoadError = globalLoad.error;
      this.recordError("global", globalLoad.error);
    }

    this.modifiedFields.clear();
    this.modifiedNestedFields.clear();
    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();

    const projectLoad = SettingsManager.tryLoadFromStorage(
      this.storage,
      "project",
    );
    if (!projectLoad.error) {
      this.projectSettings = projectLoad.settings;
      this.projectSettingsLoadError = null;
    } else {
      this.projectSettingsLoadError = projectLoad.error;
      this.recordError("project", projectLoad.error);
    }

    this.settings = deepMergeSettings(
      this.globalSettings,
      this.projectSettings,
    );
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.globalSettings.autocompleteMaxVisible = Math.max(
      3,
      Math.min(20, Math.floor(maxVisible)),
    );
    this.markModified("autocompleteMaxVisible");
    this.save();
  }

  setBlockImages(blocked: boolean): void {
    if (!this.globalSettings.images) {
      this.globalSettings.images = {};
    }
    this.globalSettings.images.blockImages = blocked;
    this.markModified("images", "blockImages");
    this.save();
  }

  setClearOnShrink(enabled: boolean): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.clearOnShrink = enabled;
    this.markModified("terminal", "clearOnShrink");
    this.save();
  }

  setCollapseChangelog(collapse: boolean): void {
    this.globalSettings.collapseChangelog = collapse;
    this.markModified("collapseChangelog");
    this.save();
  }

  setCompactionEnabled(enabled: boolean): void {
    if (!this.globalSettings.compaction) {
      this.globalSettings.compaction = {};
    }
    this.globalSettings.compaction.enabled = enabled;
    this.markModified("compaction", "enabled");
    this.save();
  }

  setDefaultModel(modelId: string): void {
    this.globalSettings.defaultModel = modelId;
    this.markModified("defaultModel");
    this.save();
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.globalSettings.defaultProvider = provider;
    this.globalSettings.defaultModel = modelId;
    this.markModified("defaultProvider");
    this.markModified("defaultModel");
    this.save();
  }

  setDefaultProvider(provider: string): void {
    this.globalSettings.defaultProvider = provider;
    this.markModified("defaultProvider");
    this.save();
  }

  setDefaultThinkingLevel(
    level: "high" | "low" | "medium" | "minimal" | "off" | "xhigh",
  ): void {
    this.globalSettings.defaultThinkingLevel = level;
    this.markModified("defaultThinkingLevel");
    this.save();
  }

  setDoubleEscapeAction(action: "fork" | "none" | "tree"): void {
    this.globalSettings.doubleEscapeAction = action;
    this.markModified("doubleEscapeAction");
    this.save();
  }

  setEditorPaddingX(padding: number): void {
    this.globalSettings.editorPaddingX = Math.max(
      0,
      Math.min(3, Math.floor(padding)),
    );
    this.markModified("editorPaddingX");
    this.save();
  }

  setEnabledModels(patterns: string[] | undefined): void {
    this.globalSettings.enabledModels = patterns;
    this.markModified("enabledModels");
    this.save();
  }

  setEnableSkillCommands(enabled: boolean): void {
    this.globalSettings.enableSkillCommands = enabled;
    this.markModified("enableSkillCommands");
    this.save();
  }

  setExtensionPaths(paths: string[]): void {
    this.globalSettings.extensions = paths;
    this.markModified("extensions");
    this.save();
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.globalSettings.followUpMode = mode;
    this.markModified("followUpMode");
    this.save();
  }

  setHideThinkingBlock(hide: boolean): void {
    this.globalSettings.hideThinkingBlock = hide;
    this.markModified("hideThinkingBlock");
    this.save();
  }

  setImageAutoResize(enabled: boolean): void {
    if (!this.globalSettings.images) {
      this.globalSettings.images = {};
    }
    this.globalSettings.images.autoResize = enabled;
    this.markModified("images", "autoResize");
    this.save();
  }

  setLastChangelogVersion(version: string): void {
    this.globalSettings.lastChangelogVersion = version;
    this.markModified("lastChangelogVersion");
    this.save();
  }

  setNpmCommand(command: string[] | undefined): void {
    this.globalSettings.npmCommand = command ? [...command] : undefined;
    this.markModified("npmCommand");
    this.save();
  }

  setPackages(packages: PackageSource[]): void {
    this.globalSettings.packages = packages;
    this.markModified("packages");
    this.save();
  }

  setProjectExtensionPaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.extensions = paths;
    this.markProjectModified("extensions");
    this.saveProjectSettings(projectSettings);
  }

  setProjectPackages(packages: PackageSource[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.packages = packages;
    this.markProjectModified("packages");
    this.saveProjectSettings(projectSettings);
  }

  setProjectPromptTemplatePaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.prompts = paths;
    this.markProjectModified("prompts");
    this.saveProjectSettings(projectSettings);
  }

  setProjectSkillPaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.skills = paths;
    this.markProjectModified("skills");
    this.saveProjectSettings(projectSettings);
  }

  setProjectThemePaths(paths: string[]): void {
    const projectSettings = structuredClone(this.projectSettings);
    projectSettings.themes = paths;
    this.markProjectModified("themes");
    this.saveProjectSettings(projectSettings);
  }

  setPromptTemplatePaths(paths: string[]): void {
    this.globalSettings.prompts = paths;
    this.markModified("prompts");
    this.save();
  }

  setQuietStartup(quiet: boolean): void {
    this.globalSettings.quietStartup = quiet;
    this.markModified("quietStartup");
    this.save();
  }

  setRetryEnabled(enabled: boolean): void {
    if (!this.globalSettings.retry) {
      this.globalSettings.retry = {};
    }
    this.globalSettings.retry.enabled = enabled;
    this.markModified("retry", "enabled");
    this.save();
  }

  setShellCommandPrefix(prefix: string | undefined): void {
    this.globalSettings.shellCommandPrefix = prefix;
    this.markModified("shellCommandPrefix");
    this.save();
  }

  setShellPath(path: string | undefined): void {
    this.globalSettings.shellPath = path;
    this.markModified("shellPath");
    this.save();
  }

  setShowHardwareCursor(enabled: boolean): void {
    this.globalSettings.showHardwareCursor = enabled;
    this.markModified("showHardwareCursor");
    this.save();
  }

  setShowImages(show: boolean): void {
    if (!this.globalSettings.terminal) {
      this.globalSettings.terminal = {};
    }
    this.globalSettings.terminal.showImages = show;
    this.markModified("terminal", "showImages");
    this.save();
  }

  setSkillPaths(paths: string[]): void {
    this.globalSettings.skills = paths;
    this.markModified("skills");
    this.save();
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.globalSettings.steeringMode = mode;
    this.markModified("steeringMode");
    this.save();
  }

  setTheme(theme: string): void {
    this.globalSettings.theme = theme;
    this.markModified("theme");
    this.save();
  }

  setThemePaths(paths: string[]): void {
    this.globalSettings.themes = paths;
    this.markModified("themes");
    this.save();
  }

  setTransport(transport: TransportSetting): void {
    this.globalSettings.transport = transport;
    this.markModified("transport");
    this.save();
  }

  setTreeFilterMode(
    mode: "all" | "default" | "labeled-only" | "no-tools" | "user-only",
  ): void {
    this.globalSettings.treeFilterMode = mode;
    this.markModified("treeFilterMode");
    this.save();
  }

  private clearModifiedScope(scope: SettingsScope): void {
    if (scope === "global") {
      this.modifiedFields.clear();
      this.modifiedNestedFields.clear();
      return;
    }

    this.modifiedProjectFields.clear();
    this.modifiedProjectNestedFields.clear();
  }

  private cloneModifiedNestedFields(
    source: Map<keyof Settings, Set<string>>,
  ): Map<keyof Settings, Set<string>> {
    const snapshot = new Map<keyof Settings, Set<string>>();
    for (const [key, value] of source.entries()) {
      snapshot.set(key, new Set(value));
    }
    return snapshot;
  }

  private enqueueWrite(scope: SettingsScope, task: () => void): void {
    this.writeQueue = this.writeQueue
      .then(() => {
        task();
        this.clearModifiedScope(scope);
      })
      .catch((error) => {
        this.recordError(scope, error);
      });
  }

  /** Mark a global field as modified during this session */
  private markModified(field: keyof Settings, nestedKey?: string): void {
    this.modifiedFields.add(field);
    if (nestedKey) {
      if (!this.modifiedNestedFields.has(field)) {
        this.modifiedNestedFields.set(field, new Set());
      }
      this.modifiedNestedFields.get(field)!.add(nestedKey);
    }
  }

  /** Mark a project field as modified during this session */
  private markProjectModified(field: keyof Settings, nestedKey?: string): void {
    this.modifiedProjectFields.add(field);
    if (nestedKey) {
      if (!this.modifiedProjectNestedFields.has(field)) {
        this.modifiedProjectNestedFields.set(field, new Set());
      }
      this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
    }
  }

  private persistScopedSettings(
    scope: SettingsScope,
    snapshotSettings: Settings,
    modifiedFields: Set<keyof Settings>,
    modifiedNestedFields: Map<keyof Settings, Set<string>>,
  ): void {
    this.storage.withLock(scope, (current) => {
      const currentFileSettings = current
        ? SettingsManager.migrateSettings(
            JSON.parse(current) as Record<string, unknown>,
          )
        : {};
      const mergedSettings: Settings = { ...currentFileSettings };
      for (const field of modifiedFields) {
        const value = snapshotSettings[field];
        if (
          modifiedNestedFields.has(field) &&
          typeof value === "object" &&
          value !== null
        ) {
          const nestedModified = modifiedNestedFields.get(field)!;
          const baseNested =
            (currentFileSettings[field] as Record<string, unknown>) ?? {};
          const inMemoryNested = value as Record<string, unknown>;
          const mergedNested = { ...baseNested };
          for (const nestedKey of nestedModified) {
            mergedNested[nestedKey] = inMemoryNested[nestedKey];
          }
          (mergedSettings as Record<string, unknown>)[field] = mergedNested;
        } else {
          (mergedSettings as Record<string, unknown>)[field] = value;
        }
      }

      return JSON.stringify(mergedSettings, null, 2);
    });
  }

  private recordError(scope: SettingsScope, error: unknown): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    this.errors.push({ error: normalizedError, scope });
  }

  private save(): void {
    this.settings = deepMergeSettings(
      this.globalSettings,
      this.projectSettings,
    );

    if (this.globalSettingsLoadError) {
      return;
    }

    const snapshotGlobalSettings = structuredClone(this.globalSettings);
    const modifiedFields = new Set(this.modifiedFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(
      this.modifiedNestedFields,
    );

    this.enqueueWrite("global", () => {
      this.persistScopedSettings(
        "global",
        snapshotGlobalSettings,
        modifiedFields,
        modifiedNestedFields,
      );
    });
  }

  private saveProjectSettings(settings: Settings): void {
    this.projectSettings = structuredClone(settings);
    this.settings = deepMergeSettings(
      this.globalSettings,
      this.projectSettings,
    );

    if (this.projectSettingsLoadError) {
      return;
    }

    const snapshotProjectSettings = structuredClone(this.projectSettings);
    const modifiedFields = new Set(this.modifiedProjectFields);
    const modifiedNestedFields = this.cloneModifiedNestedFields(
      this.modifiedProjectNestedFields,
    );
    this.enqueueWrite("project", () => {
      this.persistScopedSettings(
        "project",
        snapshotProjectSettings,
        modifiedFields,
        modifiedNestedFields,
      );
    });
  }
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
  const result: Settings = { ...base };

  for (const key of Object.keys(overrides) as (keyof Settings)[]) {
    const overrideValue = overrides[key];
    const baseValue = base[key];

    if (overrideValue === undefined) {
      continue;
    }

    // For nested objects, merge recursively
    if (
      typeof overrideValue === "object" &&
      overrideValue !== null &&
      !Array.isArray(overrideValue) &&
      typeof baseValue === "object" &&
      baseValue !== null &&
      !Array.isArray(baseValue)
    ) {
      (result as Record<string, unknown>)[key] = {
        ...baseValue,
        ...overrideValue,
      };
    } else {
      // For primitives and arrays, override value wins
      (result as Record<string, unknown>)[key] = overrideValue;
    }
  }

  return result;
}
