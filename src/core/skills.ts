import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "fs";
import ignore from "ignore";
import { homedir } from "os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "path";

import type { ResourceDiagnostic } from "./diagnostics.js";

import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export interface LoadSkillsFromDirOptions {
  /** Directory to scan for skills */
  dir: string;
  /** Source identifier for these skills */
  source: string;
}

export interface LoadSkillsOptions {
  /** Agent config directory for global skills. Default: ~/.pi/agent */
  agentDir?: string;
  /** Working directory for project-local skills. Default: process.cwd() */
  cwd?: string;
  /** Include default skills directories. Default: true */
  includeDefaults?: boolean;
  /** Explicit skill paths (files or directories) */
  skillPaths?: string[];
}

export interface LoadSkillsResult {
  diagnostics: ResourceDiagnostic[];
  skills: Skill[];
}

export interface Skill {
  baseDir: string;
  description: string;
  disableModelInvocation: boolean;
  filePath: string;
  name: string;
  sourceInfo: SourceInfo;
}

export interface SkillFrontmatter {
  [key: string]: unknown;
  description?: string;
  "disable-model-invocation"?: boolean;
  name?: string;
}

type IgnoreMatcher = ReturnType<typeof ignore>;

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(skill.description)}</description>`,
    );
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}

/**
 * Load skills from all configured locations.
 * Returns skills and any validation diagnostics.
 */
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
  const {
    agentDir,
    cwd = process.cwd(),
    includeDefaults = true,
    skillPaths = [],
  } = options;

  // Resolve agentDir - if not provided, use default from config
  const resolvedAgentDir = agentDir ?? getAgentDir();

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const allDiagnostics: ResourceDiagnostic[] = [];
  const collisionDiagnostics: ResourceDiagnostic[] = [];

  function addSkills(result: LoadSkillsResult) {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      // Resolve symlinks to detect duplicate files
      let realPath: string;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }

      // Skip silently if we've already loaded this exact file (via symlink)
      if (realPathSet.has(realPath)) {
        continue;
      }

      const existing = skillMap.get(skill.name);
      if (existing) {
        collisionDiagnostics.push({
          collision: {
            loserPath: skill.filePath,
            name: skill.name,
            resourceType: "skill",
            winnerPath: existing.filePath,
          },
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          type: "collision",
        });
      } else {
        skillMap.set(skill.name, skill);
        realPathSet.add(realPath);
      }
    }
  }

  if (includeDefaults) {
    addSkills(
      loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true),
    );
    addSkills(
      loadSkillsFromDirInternal(
        resolve(cwd, CONFIG_DIR_NAME, "skills"),
        "project",
        true,
      ),
    );
  }

  const userSkillsDir = join(resolvedAgentDir, "skills");
  const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");

  const isUnderPath = (target: string, root: string): boolean => {
    const normalizedRoot = resolve(root);
    if (target === normalizedRoot) {
      return true;
    }
    const prefix = normalizedRoot.endsWith(sep)
      ? normalizedRoot
      : `${normalizedRoot}${sep}`;
    return target.startsWith(prefix);
  };

  const getSource = (resolvedPath: string): "path" | "project" | "user" => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
      if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
    }
    return "path";
  };

  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push({
        message: "skill path does not exist",
        path: resolvedPath,
        type: "warning",
      });
      continue;
    }

    try {
      const stats = statSync(resolvedPath);
      const source = getSource(resolvedPath);
      if (stats.isDirectory()) {
        addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const result = loadSkillFromFile(resolvedPath, source);
        if (result.skill) {
          addSkills({
            diagnostics: result.diagnostics,
            skills: [result.skill],
          });
        } else {
          allDiagnostics.push(...result.diagnostics);
        }
      } else {
        allDiagnostics.push({
          message: "skill path is not a markdown file",
          path: resolvedPath,
          type: "warning",
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "failed to read skill path";
      allDiagnostics.push({ message, path: resolvedPath, type: "warning" });
    }
  }

  return {
    diagnostics: [...allDiagnostics, ...collisionDiagnostics],
    skills: Array.from(skillMap.values()),
  };
}

/**
 * Load skills from a directory.
 *
 * Discovery rules:
 * - if a directory contains SKILL.md, treat it as a skill root and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories to find SKILL.md
 */
export function loadSkillsFromDir(
  options: LoadSkillsFromDirOptions,
): LoadSkillsResult {
  const { dir, source } = options;
  return loadSkillsFromDirInternal(dir, source, true);
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) {
        ig.add(patterns);
      }
    } catch {}
  }
}

function createSkillSourceInfo(
  filePath: string,
  baseDir: string,
  source: string,
): SourceInfo {
  switch (source) {
    case "path":
      return createSyntheticSourceInfo(filePath, {
        baseDir,
        source: "local",
      });
    case "project":
      return createSyntheticSourceInfo(filePath, {
        baseDir,
        scope: "project",
        source: "local",
      });
    case "user":
      return createSyntheticSourceInfo(filePath, {
        baseDir,
        scope: "user",
        source: "local",
      });
    default:
      return createSyntheticSourceInfo(filePath, { baseDir, source });
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function loadSkillFromFile(
  filePath: string,
  source: string,
): { diagnostics: ResourceDiagnostic[]; skill: null | Skill; } {
  const diagnostics: ResourceDiagnostic[] = [];

  try {
    const rawContent = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);

    // Validate description
    const descErrors = validateDescription(frontmatter.description);
    for (const error of descErrors) {
      diagnostics.push({ message: error, path: filePath, type: "warning" });
    }

    // Use name from frontmatter, or fall back to parent directory name
    const name = frontmatter.name || parentDirName;

    // Validate name
    const nameErrors = validateName(name, parentDirName);
    for (const error of nameErrors) {
      diagnostics.push({ message: error, path: filePath, type: "warning" });
    }

    // Still load the skill even with warnings (unless description is completely missing)
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { diagnostics, skill: null };
    }

    return {
      diagnostics,
      skill: {
        baseDir: skillDir,
        description: frontmatter.description,
        disableModelInvocation:
          frontmatter["disable-model-invocation"] === true,
        filePath,
        name,
        sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
      },
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to parse skill file";
    diagnostics.push({ message, path: filePath, type: "warning" });
    return { diagnostics, skill: null };
  }
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: ResourceDiagnostic[] = [];

  if (!existsSync(dir)) {
    return { diagnostics, skills };
  }

  const root = rootDir ?? dir;
  const ig = ignoreMatcher ?? ignore();
  addIgnoreRules(ig, dir, root);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name !== "SKILL.md") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }

      const relPath = toPosixPath(relative(root, fullPath));
      if (!isFile || ig.ignores(relPath)) {
        continue;
      }

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
      return { diagnostics, skills };
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      // Skip node_modules to avoid scanning dependencies
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);

      // For symlinks, check if they point to a directory and follow them
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          // Broken symlink, skip it
          continue;
        }
      }

      const relPath = toPosixPath(relative(root, fullPath));
      const ignorePath = isDirectory ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }

      if (isDirectory) {
        const subResult = loadSkillsFromDirInternal(
          fullPath,
          source,
          false,
          ig,
          root,
        );
        skills.push(...subResult.skills);
        diagnostics.push(...subResult.diagnostics);
        continue;
      }

      if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
        continue;
      }

      const result = loadSkillFromFile(fullPath, source);
      if (result.skill) {
        skills.push(result.skill);
      }
      diagnostics.push(...result.diagnostics);
    }
  } catch {}

  return { diagnostics, skills };
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  return trimmed;
}

function prefixIgnorePattern(line: string, prefix: string): null | string {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

function resolveSkillPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Validate description per Agent Skills spec.
 */
function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];

  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }

  return errors;
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 */
function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];

  if (name !== parentDirName) {
    errors.push(
      `name "${name}" does not match parent directory "${parentDirName}"`,
    );
  }

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      `name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`,
    );
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }

  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }

  return errors;
}
