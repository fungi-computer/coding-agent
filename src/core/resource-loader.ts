import chalk from "chalk";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { Theme } from "../modes/interactive/theme/theme.js";

import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";

const loadThemeFromPath = (_path: string) => ({}) as Theme;
import type { ResourceDiagnostic } from "./diagnostics.js";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.js";

import type {
  Extension,
  ExtensionFactory,
  ExtensionRuntime,
  LoadExtensionsResult,
} from "./extensions/index.js";
import type { PromptTemplate } from "./prompt-templates.js";
import type { Skill } from "./skills.js";

import { isLocalPath } from "../utils/paths.js";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
  loadExtensions,
} from "./extensions/index.js";
import { DefaultPackageManager, type PathMetadata } from "./package-manager.js";
import { loadPromptTemplates } from "./prompt-templates.js";
import { SettingsManager } from "./settings-manager.js";
import { loadSkills } from "./skills.js";
import { createSourceInfo, type SourceInfo } from "./source-info.js";

export interface DefaultResourceLoaderOptions {
  additionalExtensionPaths?: string[];
  additionalPromptTemplatePaths?: string[];
  additionalSkillPaths?: string[];
  additionalThemePaths?: string[];
  agentDir?: string;
  agentsFilesOverride?: (base: {
    agentsFiles: { content: string; path: string; }[];
  }) => {
    agentsFiles: { content: string; path: string; }[];
  };
  appendSystemPrompt?: string;
  appendSystemPromptOverride?: (base: string[]) => string[];
  cwd?: string;
  extensionFactories?: ExtensionFactory[];
  extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
  noExtensions?: boolean;
  noPromptTemplates?: boolean;
  noSkills?: boolean;
  noThemes?: boolean;
  promptsOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  };
  settingsManager?: SettingsManager;
  skillsOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    skills: Skill[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    skills: Skill[];
  };
  systemPrompt?: string;
  systemPromptOverride?: (base: string | undefined) => string | undefined;
  themesOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  };
}

export interface ResourceExtensionPaths {
  promptPaths?: { metadata: PathMetadata; path: string; }[];
  skillPaths?: { metadata: PathMetadata; path: string; }[];
  themePaths?: { metadata: PathMetadata; path: string; }[];
}

export interface ResourceLoader {
  extendResources(paths: ResourceExtensionPaths): void;
  getAgentsFiles(): { agentsFiles: { content: string; path: string; }[] };
  getAppendSystemPrompt(): string[];
  getExtensions(): LoadExtensionsResult;
  getPrompts(): {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  };
  getSkills(): { diagnostics: ResourceDiagnostic[]; skills: Skill[]; };
  getSystemPrompt(): string | undefined;
  getThemes(): { diagnostics: ResourceDiagnostic[]; themes: Theme[]; };
  reload(): Promise<void>;
}

export class DefaultResourceLoader implements ResourceLoader {
  private additionalExtensionPaths: string[];
  private additionalPromptTemplatePaths: string[];
  private additionalSkillPaths: string[];
  private additionalThemePaths: string[];
  private agentDir: string;
  private agentsFiles: { content: string; path: string; }[];
  private agentsFilesOverride?: (base: {
    agentsFiles: { content: string; path: string; }[];
  }) => {
    agentsFiles: { content: string; path: string; }[];
  };
  private appendSystemPrompt: string[];
  private appendSystemPromptOverride?: (base: string[]) => string[];
  private appendSystemPromptSource?: string;
  private cwd: string;
  private extensionFactories: ExtensionFactory[];
  private extensionPromptSourceInfos: Map<string, SourceInfo>;
  private extensionSkillSourceInfos: Map<string, SourceInfo>;
  private extensionsOverride?: (
    base: LoadExtensionsResult,
  ) => LoadExtensionsResult;
  private extensionsResult: LoadExtensionsResult;
  private extensionThemeSourceInfos: Map<string, SourceInfo>;
  private lastPromptPaths: string[];
  private lastSkillPaths: string[];
  private lastThemePaths: string[];
  private noExtensions: boolean;
  private noPromptTemplates: boolean;

  private noSkills: boolean;
  private noThemes: boolean;
  private packageManager: DefaultPackageManager;
  private promptDiagnostics: ResourceDiagnostic[];
  private prompts: PromptTemplate[];
  private promptsOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  };
  private settingsManager: SettingsManager;
  private skillDiagnostics: ResourceDiagnostic[];
  private skills: Skill[];
  private skillsOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    skills: Skill[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    skills: Skill[];
  };
  private systemPrompt?: string;
  private systemPromptOverride?: (
    base: string | undefined,
  ) => string | undefined;
  private systemPromptSource?: string;
  private themeDiagnostics: ResourceDiagnostic[];
  private themes: Theme[];
  private themesOverride?: (base: {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  }) => {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  };

  constructor(options: DefaultResourceLoaderOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.agentDir = options.agentDir ?? getAgentDir();
    this.settingsManager =
      options.settingsManager ??
      SettingsManager.create(this.cwd, this.agentDir);
    this.packageManager = new DefaultPackageManager({
      agentDir: this.agentDir,
      cwd: this.cwd,
      settingsManager: this.settingsManager,
    });
    this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
    this.additionalSkillPaths = options.additionalSkillPaths ?? [];
    this.additionalPromptTemplatePaths =
      options.additionalPromptTemplatePaths ?? [];
    this.additionalThemePaths = options.additionalThemePaths ?? [];
    this.extensionFactories = options.extensionFactories ?? [];
    this.noExtensions = options.noExtensions ?? false;
    this.noSkills = options.noSkills ?? false;
    this.noPromptTemplates = options.noPromptTemplates ?? false;
    this.noThemes = options.noThemes ?? false;
    this.systemPromptSource = options.systemPrompt;
    this.appendSystemPromptSource = options.appendSystemPrompt;
    this.extensionsOverride = options.extensionsOverride;
    this.skillsOverride = options.skillsOverride;
    this.promptsOverride = options.promptsOverride;
    this.themesOverride = options.themesOverride;
    this.agentsFilesOverride = options.agentsFilesOverride;
    this.systemPromptOverride = options.systemPromptOverride;
    this.appendSystemPromptOverride = options.appendSystemPromptOverride;

    this.extensionsResult = {
      errors: [],
      extensions: [],
      runtime: createExtensionRuntime(),
    };
    this.skills = [];
    this.skillDiagnostics = [];
    this.prompts = [];
    this.promptDiagnostics = [];
    this.themes = [];
    this.themeDiagnostics = [];
    this.agentsFiles = [];
    this.appendSystemPrompt = [];
    this.lastSkillPaths = [];
    this.extensionSkillSourceInfos = new Map();
    this.extensionPromptSourceInfos = new Map();
    this.extensionThemeSourceInfos = new Map();
    this.lastPromptPaths = [];
    this.lastThemePaths = [];
  }

  extendResources(paths: ResourceExtensionPaths): void {
    const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
    const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
    const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

    for (const entry of skillPaths) {
      this.extensionSkillSourceInfos.set(
        entry.path,
        createSourceInfo(entry.path, entry.metadata),
      );
    }
    for (const entry of promptPaths) {
      this.extensionPromptSourceInfos.set(
        entry.path,
        createSourceInfo(entry.path, entry.metadata),
      );
    }
    for (const entry of themePaths) {
      this.extensionThemeSourceInfos.set(
        entry.path,
        createSourceInfo(entry.path, entry.metadata),
      );
    }

    if (skillPaths.length > 0) {
      this.lastSkillPaths = this.mergePaths(
        this.lastSkillPaths,
        skillPaths.map((entry) => entry.path),
      );
      this.updateSkillsFromPaths(this.lastSkillPaths);
    }

    if (promptPaths.length > 0) {
      this.lastPromptPaths = this.mergePaths(
        this.lastPromptPaths,
        promptPaths.map((entry) => entry.path),
      );
      this.updatePromptsFromPaths(this.lastPromptPaths);
    }

    if (themePaths.length > 0) {
      this.lastThemePaths = this.mergePaths(
        this.lastThemePaths,
        themePaths.map((entry) => entry.path),
      );
      this.updateThemesFromPaths(this.lastThemePaths);
    }
  }

  getAgentsFiles(): { agentsFiles: { content: string; path: string; }[] } {
    return { agentsFiles: this.agentsFiles };
  }

  getAppendSystemPrompt(): string[] {
    return this.appendSystemPrompt;
  }

  getExtensions(): LoadExtensionsResult {
    return this.extensionsResult;
  }

  getPrompts(): {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  } {
    return { diagnostics: this.promptDiagnostics, prompts: this.prompts };
  }

  getSkills(): { diagnostics: ResourceDiagnostic[]; skills: Skill[]; } {
    return { diagnostics: this.skillDiagnostics, skills: this.skills };
  }

  getSystemPrompt(): string | undefined {
    return this.systemPrompt;
  }

  getThemes(): { diagnostics: ResourceDiagnostic[]; themes: Theme[]; } {
    return { diagnostics: this.themeDiagnostics, themes: this.themes };
  }

  async reload(): Promise<void> {
    await this.settingsManager.reload();
    const resolvedPaths = await this.packageManager.resolve();
    const cliExtensionPaths = await this.packageManager.resolveExtensionSources(
      this.additionalExtensionPaths,
      {
        temporary: true,
      },
    );
    const metadataByPath = new Map<string, PathMetadata>();

    this.extensionSkillSourceInfos = new Map();
    this.extensionPromptSourceInfos = new Map();
    this.extensionThemeSourceInfos = new Map();

    // Helper to extract enabled paths and store metadata
    const getEnabledResources = (
      resources: {
        enabled: boolean;
        metadata: PathMetadata;
        path: string;
      }[],
    ): { enabled: boolean; metadata: PathMetadata; path: string; }[] => {
      for (const r of resources) {
        if (!metadataByPath.has(r.path)) {
          metadataByPath.set(r.path, r.metadata);
        }
      }
      return resources.filter((r) => r.enabled);
    };

    const getEnabledPaths = (
      resources: {
        enabled: boolean;
        metadata: PathMetadata;
        path: string;
      }[],
    ): string[] => getEnabledResources(resources).map((r) => r.path);
    const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
    const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
    const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
    const enabledThemes = getEnabledPaths(resolvedPaths.themes);

    const mapSkillPath = (resource: {
      metadata: PathMetadata;
      path: string;
    }): string => {
      if (
        resource.metadata.source !== "auto" &&
        resource.metadata.origin !== "package"
      ) {
        return resource.path;
      }
      try {
        const stats = statSync(resource.path);
        if (!stats.isDirectory()) {
          return resource.path;
        }
      } catch {
        return resource.path;
      }
      const skillFile = join(resource.path, "SKILL.md");
      if (existsSync(skillFile)) {
        if (!metadataByPath.has(skillFile)) {
          metadataByPath.set(skillFile, resource.metadata);
        }
        return skillFile;
      }
      return resource.path;
    };

    const enabledSkills = enabledSkillResources.map(mapSkillPath);

    // Add CLI paths metadata
    for (const r of cliExtensionPaths.extensions) {
      if (!metadataByPath.has(r.path)) {
        metadataByPath.set(r.path, {
          origin: "top-level",
          scope: "temporary",
          source: "cli",
        });
      }
    }
    for (const r of cliExtensionPaths.skills) {
      if (!metadataByPath.has(r.path)) {
        metadataByPath.set(r.path, {
          origin: "top-level",
          scope: "temporary",
          source: "cli",
        });
      }
    }

    const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
    const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
    const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
    const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

    const extensionPaths = this.noExtensions
      ? cliEnabledExtensions
      : this.mergePaths(cliEnabledExtensions, enabledExtensions);

    const extensionsResult = await loadExtensions(extensionPaths, this.cwd);
    const inlineExtensions = await this.loadExtensionFactories(
      extensionsResult.runtime,
    );
    extensionsResult.extensions.push(...inlineExtensions.extensions);
    extensionsResult.errors.push(...inlineExtensions.errors);

    // Detect extension conflicts (tools, commands, flags with same names from different extensions)
    // Keep all extensions loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
    const conflicts = this.detectExtensionConflicts(
      extensionsResult.extensions,
    );
    for (const conflict of conflicts) {
      extensionsResult.errors.push({
        error: conflict.message,
        path: conflict.path,
      });
    }

    for (const p of this.additionalExtensionPaths) {
      if (isLocalPath(p) && !existsSync(p)) {
        extensionsResult.errors.push({
          error: `Extension path does not exist: ${p}`,
          path: p,
        });
      }
    }
    this.extensionsResult = this.extensionsOverride
      ? this.extensionsOverride(extensionsResult)
      : extensionsResult;
    this.applyExtensionSourceInfo(
      this.extensionsResult.extensions,
      metadataByPath,
    );

    const skillPaths = this.noSkills
      ? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
      : this.mergePaths(
          [...cliEnabledSkills, ...enabledSkills],
          this.additionalSkillPaths,
        );

    this.lastSkillPaths = skillPaths;
    this.updateSkillsFromPaths(skillPaths, metadataByPath);
    for (const p of this.additionalSkillPaths) {
      if (
        isLocalPath(p) &&
        !existsSync(p) &&
        !this.skillDiagnostics.some((d) => d.path === p)
      ) {
        this.skillDiagnostics.push({
          message: "Skill path does not exist",
          path: p,
          type: "error",
        });
      }
    }

    const promptPaths = this.noPromptTemplates
      ? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
      : this.mergePaths(
          [...cliEnabledPrompts, ...enabledPrompts],
          this.additionalPromptTemplatePaths,
        );

    this.lastPromptPaths = promptPaths;
    this.updatePromptsFromPaths(promptPaths, metadataByPath);
    for (const p of this.additionalPromptTemplatePaths) {
      if (
        isLocalPath(p) &&
        !existsSync(p) &&
        !this.promptDiagnostics.some((d) => d.path === p)
      ) {
        this.promptDiagnostics.push({
          message: "Prompt template path does not exist",
          path: p,
          type: "error",
        });
      }
    }

    const themePaths = this.noThemes
      ? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
      : this.mergePaths(
          [...cliEnabledThemes, ...enabledThemes],
          this.additionalThemePaths,
        );

    this.lastThemePaths = themePaths;
    this.updateThemesFromPaths(themePaths, metadataByPath);
    for (const p of this.additionalThemePaths) {
      if (!existsSync(p) && !this.themeDiagnostics.some((d) => d.path === p)) {
        this.themeDiagnostics.push({
          message: "Theme path does not exist",
          path: p,
          type: "error",
        });
      }
    }

    const agentsFiles = {
      agentsFiles: loadProjectContextFiles({
        agentDir: this.agentDir,
        cwd: this.cwd,
      }),
    };
    const resolvedAgentsFiles = this.agentsFilesOverride
      ? this.agentsFilesOverride(agentsFiles)
      : agentsFiles;
    this.agentsFiles = resolvedAgentsFiles.agentsFiles;

    const baseSystemPrompt = resolvePromptInput(
      this.systemPromptSource ?? this.discoverSystemPromptFile(),
      "system prompt",
    );
    this.systemPrompt = this.systemPromptOverride
      ? this.systemPromptOverride(baseSystemPrompt)
      : baseSystemPrompt;

    const appendSource =
      this.appendSystemPromptSource ?? this.discoverAppendSystemPromptFile();
    const resolvedAppend = resolvePromptInput(
      appendSource,
      "append system prompt",
    );
    const baseAppend = resolvedAppend ? [resolvedAppend] : [];
    this.appendSystemPrompt = this.appendSystemPromptOverride
      ? this.appendSystemPromptOverride(baseAppend)
      : baseAppend;
  }

  private applyExtensionSourceInfo(
    extensions: Extension[],
    metadataByPath: Map<string, PathMetadata>,
  ): void {
    for (const extension of extensions) {
      extension.sourceInfo =
        this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
        this.getDefaultSourceInfoForPath(extension.path);
      for (const command of extension.commands.values()) {
        command.sourceInfo = extension.sourceInfo;
      }
      for (const tool of extension.tools.values()) {
        tool.sourceInfo = extension.sourceInfo;
      }
    }
  }

  private dedupePrompts(prompts: PromptTemplate[]): {
    diagnostics: ResourceDiagnostic[];
    prompts: PromptTemplate[];
  } {
    const seen = new Map<string, PromptTemplate>();
    const diagnostics: ResourceDiagnostic[] = [];

    for (const prompt of prompts) {
      const existing = seen.get(prompt.name);
      if (existing) {
        diagnostics.push({
          collision: {
            loserPath: prompt.filePath,
            name: prompt.name,
            resourceType: "prompt",
            winnerPath: existing.filePath,
          },
          message: `name "/${prompt.name}" collision`,
          path: prompt.filePath,
          type: "collision",
        });
      } else {
        seen.set(prompt.name, prompt);
      }
    }

    return { diagnostics, prompts: Array.from(seen.values()) };
  }

  private dedupeThemes(themes: Theme[]): {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  } {
    const seen = new Map<string, Theme>();
    const diagnostics: ResourceDiagnostic[] = [];

    for (const t of themes) {
      const name = t.name ?? "unnamed";
      const existing = seen.get(name);
      if (existing) {
        diagnostics.push({
          collision: {
            loserPath: t.sourcePath ?? "<builtin>",
            name,
            resourceType: "theme",
            winnerPath: existing.sourcePath ?? "<builtin>",
          },
          message: `name "${name}" collision`,
          path: t.sourcePath,
          type: "collision",
        });
      } else {
        seen.set(name, t);
      }
    }

    return { diagnostics, themes: Array.from(seen.values()) };
  }

  private detectExtensionConflicts(
    extensions: Extension[],
  ): { message: string; path: string; }[] {
    const conflicts: { message: string; path: string; }[] = [];

    // Track which extension registered each tool and flag
    const toolOwners = new Map<string, string>();
    const flagOwners = new Map<string, string>();

    for (const ext of extensions) {
      // Check tools
      for (const toolName of ext.tools.keys()) {
        const existingOwner = toolOwners.get(toolName);
        if (existingOwner && existingOwner !== ext.path) {
          conflicts.push({
            message: `Tool "${toolName}" conflicts with ${existingOwner}`,
            path: ext.path,
          });
        } else {
          toolOwners.set(toolName, ext.path);
        }
      }

      // Check flags
      for (const flagName of ext.flags.keys()) {
        const existingOwner = flagOwners.get(flagName);
        if (existingOwner && existingOwner !== ext.path) {
          conflicts.push({
            message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
            path: ext.path,
          });
        } else {
          flagOwners.set(flagName, ext.path);
        }
      }
    }

    return conflicts;
  }

  private discoverAppendSystemPromptFile(): string | undefined {
    const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
    if (existsSync(projectPath)) {
      return projectPath;
    }

    const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
    if (existsSync(globalPath)) {
      return globalPath;
    }

    return undefined;
  }

  private discoverSystemPromptFile(): string | undefined {
    const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
    if (existsSync(projectPath)) {
      return projectPath;
    }

    const globalPath = join(this.agentDir, "SYSTEM.md");
    if (existsSync(globalPath)) {
      return globalPath;
    }

    return undefined;
  }

  private findSourceInfoForPath(
    resourcePath: string,
    extraSourceInfos?: Map<string, SourceInfo>,
    metadataByPath?: Map<string, PathMetadata>,
  ): SourceInfo | undefined {
    if (!resourcePath) {
      return undefined;
    }

    if (resourcePath.startsWith("<")) {
      return this.getDefaultSourceInfoForPath(resourcePath);
    }

    const normalizedResourcePath = resolve(resourcePath);
    if (extraSourceInfos) {
      for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
        const normalizedSourcePath = resolve(sourcePath);
        if (
          normalizedResourcePath === normalizedSourcePath ||
          normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
        ) {
          return { ...sourceInfo, path: resourcePath };
        }
      }
    }

    if (metadataByPath) {
      const exact =
        metadataByPath.get(normalizedResourcePath) ??
        metadataByPath.get(resourcePath);
      if (exact) {
        return createSourceInfo(resourcePath, exact);
      }

      for (const [sourcePath, metadata] of metadataByPath.entries()) {
        const normalizedSourcePath = resolve(sourcePath);
        if (
          normalizedResourcePath === normalizedSourcePath ||
          normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
        ) {
          return createSourceInfo(resourcePath, metadata);
        }
      }
    }

    return undefined;
  }

  private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
    if (filePath.startsWith("<") && filePath.endsWith(">")) {
      return {
        origin: "top-level",
        path: filePath,
        scope: "temporary",
        source: filePath.slice(1, -1).split(":")[0] || "temporary",
      };
    }

    const normalizedPath = resolve(filePath);
    const agentRoots = [
      join(this.agentDir, "skills"),
      join(this.agentDir, "prompts"),
      join(this.agentDir, "themes"),
      join(this.agentDir, "extensions"),
    ];
    const projectRoots = [
      join(this.cwd, CONFIG_DIR_NAME, "skills"),
      join(this.cwd, CONFIG_DIR_NAME, "prompts"),
      join(this.cwd, CONFIG_DIR_NAME, "themes"),
      join(this.cwd, CONFIG_DIR_NAME, "extensions"),
    ];

    for (const root of agentRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        return {
          baseDir: root,
          origin: "top-level",
          path: filePath,
          scope: "user",
          source: "local",
        };
      }
    }

    for (const root of projectRoots) {
      if (this.isUnderPath(normalizedPath, root)) {
        return {
          baseDir: root,
          origin: "top-level",
          path: filePath,
          scope: "project",
          source: "local",
        };
      }
    }

    return {
      baseDir: statSync(normalizedPath).isDirectory()
        ? normalizedPath
        : resolve(normalizedPath, ".."),
      origin: "top-level",
      path: filePath,
      scope: "temporary",
      source: "local",
    };
  }

  private isUnderPath(target: string, root: string): boolean {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep)
      ? normalizedRoot
      : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  }

  private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
    errors: { error: string; path: string; }[];
    extensions: Extension[];
  }> {
    const extensions: Extension[] = [];
    const errors: { error: string; path: string; }[] = [];

    for (const [index, factory] of this.extensionFactories.entries()) {
      const extensionPath = `<inline:${index + 1}>`;
      try {
        const extension = await loadExtensionFromFactory(
          factory,
          this.cwd,
          runtime,
          extensionPath,
        );
        extensions.push(extension);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "failed to load extension";
        errors.push({ error: message, path: extensionPath });
      }
    }

    return { errors, extensions };
  }

  private loadThemeFromFile(
    filePath: string,
    themes: Theme[],
    diagnostics: ResourceDiagnostic[],
  ): void {
    try {
      themes.push(loadThemeFromPath(filePath));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "failed to load theme";
      diagnostics.push({ message, path: filePath, type: "warning" });
    }
  }

  private loadThemes(
    paths: string[],
    includeDefaults = true,
  ): {
    diagnostics: ResourceDiagnostic[];
    themes: Theme[];
  } {
    const themes: Theme[] = [];
    const diagnostics: ResourceDiagnostic[] = [];
    if (includeDefaults) {
      const defaultDirs = [
        join(this.agentDir, "themes"),
        join(this.cwd, CONFIG_DIR_NAME, "themes"),
      ];

      for (const dir of defaultDirs) {
        this.loadThemesFromDir(dir, themes, diagnostics);
      }
    }

    for (const p of paths) {
      const resolved = resolve(this.cwd, p);
      if (!existsSync(resolved)) {
        diagnostics.push({
          message: "theme path does not exist",
          path: resolved,
          type: "warning",
        });
        continue;
      }

      try {
        const stats = statSync(resolved);
        if (stats.isDirectory()) {
          this.loadThemesFromDir(resolved, themes, diagnostics);
        } else if (stats.isFile() && resolved.endsWith(".json")) {
          this.loadThemeFromFile(resolved, themes, diagnostics);
        } else {
          diagnostics.push({
            message: "theme path is not a json file",
            path: resolved,
            type: "warning",
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "failed to read theme path";
        diagnostics.push({ message, path: resolved, type: "warning" });
      }
    }

    return { diagnostics, themes };
  }

  private loadThemesFromDir(
    dir: string,
    themes: Theme[],
    diagnostics: ResourceDiagnostic[],
  ): void {
    if (!existsSync(dir)) {
      return;
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        let isFile = entry.isFile();
        if (entry.isSymbolicLink()) {
          try {
            isFile = statSync(join(dir, entry.name)).isFile();
          } catch {
            continue;
          }
        }
        if (!isFile) {
          continue;
        }
        if (!entry.name.endsWith(".json")) {
          continue;
        }
        this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "failed to read theme directory";
      diagnostics.push({ message, path: dir, type: "warning" });
    }
  }

  private mergePaths(primary: string[], additional: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();

    for (const p of [...primary, ...additional]) {
      const resolved = this.resolveResourcePath(p);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      merged.push(resolved);
    }

    return merged;
  }

  private normalizeExtensionPaths(
    entries: { metadata: PathMetadata; path: string; }[],
  ): { metadata: PathMetadata; path: string; }[] {
    return entries.map((entry) => ({
      metadata: entry.metadata,
      path: this.resolveResourcePath(entry.path),
    }));
  }

  private resolveResourcePath(p: string): string {
    const trimmed = p.trim();
    let expanded = trimmed;
    if (trimmed === "~") {
      expanded = homedir();
    } else if (trimmed.startsWith("~/")) {
      expanded = join(homedir(), trimmed.slice(2));
    } else if (trimmed.startsWith("~")) {
      expanded = join(homedir(), trimmed.slice(1));
    }
    return resolve(this.cwd, expanded);
  }

  private updatePromptsFromPaths(
    promptPaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let promptsResult: {
      diagnostics: ResourceDiagnostic[];
      prompts: PromptTemplate[];
    };
    if (this.noPromptTemplates && promptPaths.length === 0) {
      promptsResult = { diagnostics: [], prompts: [] };
    } else {
      const allPrompts = loadPromptTemplates({
        agentDir: this.agentDir,
        cwd: this.cwd,
        includeDefaults: false,
        promptPaths,
      });
      promptsResult = this.dedupePrompts(allPrompts);
    }
    const resolvedPrompts = this.promptsOverride
      ? this.promptsOverride(promptsResult)
      : promptsResult;
    this.prompts = resolvedPrompts.prompts.map((prompt) => ({
      ...prompt,
      sourceInfo:
        this.findSourceInfoForPath(
          prompt.filePath,
          this.extensionPromptSourceInfos,
          metadataByPath,
        ) ??
        prompt.sourceInfo ??
        this.getDefaultSourceInfoForPath(prompt.filePath),
    }));
    this.promptDiagnostics = resolvedPrompts.diagnostics;
  }

  private updateSkillsFromPaths(
    skillPaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let skillsResult: { diagnostics: ResourceDiagnostic[]; skills: Skill[]; };
    if (this.noSkills && skillPaths.length === 0) {
      skillsResult = { diagnostics: [], skills: [] };
    } else {
      skillsResult = loadSkills({
        agentDir: this.agentDir,
        cwd: this.cwd,
        includeDefaults: false,
        skillPaths,
      });
    }
    const resolvedSkills = this.skillsOverride
      ? this.skillsOverride(skillsResult)
      : skillsResult;
    this.skills = resolvedSkills.skills.map((skill) => ({
      ...skill,
      sourceInfo:
        this.findSourceInfoForPath(
          skill.filePath,
          this.extensionSkillSourceInfos,
          metadataByPath,
        ) ??
        skill.sourceInfo ??
        this.getDefaultSourceInfoForPath(skill.filePath),
    }));
    this.skillDiagnostics = resolvedSkills.diagnostics;
  }

  private updateThemesFromPaths(
    themePaths: string[],
    metadataByPath?: Map<string, PathMetadata>,
  ): void {
    let themesResult: { diagnostics: ResourceDiagnostic[]; themes: Theme[]; };
    if (this.noThemes && themePaths.length === 0) {
      themesResult = { diagnostics: [], themes: [] };
    } else {
      const loaded = this.loadThemes(themePaths, false);
      const deduped = this.dedupeThemes(loaded.themes);
      themesResult = {
        diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
        themes: deduped.themes,
      };
    }
    const resolvedThemes = this.themesOverride
      ? this.themesOverride(themesResult)
      : themesResult;
    this.themes = resolvedThemes.themes.map((theme) => {
      const sourcePath = theme.sourcePath;
      theme.sourceInfo = sourcePath
        ? (this.findSourceInfoForPath(
            sourcePath,
            this.extensionThemeSourceInfos,
            metadataByPath,
          ) ??
          theme.sourceInfo ??
          this.getDefaultSourceInfoForPath(sourcePath))
        : theme.sourceInfo;
      return theme;
    });
    this.themeDiagnostics = resolvedThemes.diagnostics;
  }
}

function loadContextFileFromDir(
  dir: string,
): { content: string; path: string; } | null {
  const candidates = ["AGENTS.md", "CLAUDE.md"];
  for (const filename of candidates) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      try {
        return {
          content: readFileSync(filePath, "utf-8"),
          path: filePath,
        };
      } catch (error) {
        console.error(
          chalk.yellow(`Warning: Could not read ${filePath}: ${error}`),
        );
      }
    }
  }
  return null;
}

function loadProjectContextFiles(
  options: { agentDir?: string; cwd?: string; } = {},
): { content: string; path: string; }[] {
  const resolvedCwd = options.cwd ?? process.cwd();
  const resolvedAgentDir = options.agentDir ?? getAgentDir();

  const contextFiles: { content: string; path: string; }[] = [];
  const seenPaths = new Set<string>();

  const globalContext = loadContextFileFromDir(resolvedAgentDir);
  if (globalContext) {
    contextFiles.push(globalContext);
    seenPaths.add(globalContext.path);
  }

  const ancestorContextFiles: { content: string; path: string; }[] = [];

  let currentDir = resolvedCwd;
  const root = resolve("/");

  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seenPaths.has(contextFile.path)) {
      ancestorContextFiles.unshift(contextFile);
      seenPaths.add(contextFile.path);
    }

    if (currentDir === root) break;

    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  contextFiles.push(...ancestorContextFiles);

  return contextFiles;
}

function resolvePromptInput(
  input: string | undefined,
  description: string,
): string | undefined {
  if (!input) {
    return undefined;
  }

  if (existsSync(input)) {
    try {
      return readFileSync(input, "utf-8");
    } catch (error) {
      console.error(
        chalk.yellow(
          `Warning: Could not read ${description} file ${input}: ${error}`,
        ),
      );
      return input;
    }
  }

  return input;
}
