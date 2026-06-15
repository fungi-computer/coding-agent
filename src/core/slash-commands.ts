import type { SourceInfo } from "./source-info.js";

export interface BuiltinSlashCommand {
  description: string;
  name: string;
}

export interface SlashCommandInfo {
  description?: string;
  name: string;
  source: SlashCommandSource;
  sourceInfo: SourceInfo;
}

export type SlashCommandSource = "extension" | "prompt" | "skill";

export const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommand[] = [
  { description: "Open settings menu", name: "settings" },
  { description: "Select model (opens selector UI)", name: "model" },
  {
    description: "Enable/disable models for Ctrl+P cycling",
    name: "scoped-models",
  },
  {
    description: "Export session (HTML default, or specify path: .html/.jsonl)",
    name: "export",
  },
  {
    description: "Import and resume a session from a JSONL file",
    name: "import",
  },
  { description: "Share session as a secret GitHub gist", name: "share" },
  { description: "Copy last agent message to clipboard", name: "copy" },
  { description: "Set session display name", name: "name" },
  { description: "Show session info and stats", name: "session" },
  { description: "Show changelog entries", name: "changelog" },
  { description: "Show all keyboard shortcuts", name: "hotkeys" },
  { description: "Create a new fork from a previous message", name: "fork" },
  { description: "Navigate session tree (switch branches)", name: "tree" },
  { description: "Login with OAuth provider", name: "login" },
  { description: "Logout from OAuth provider", name: "logout" },
  { description: "Start a new session", name: "new" },
  { description: "Manually compact the session context", name: "compact" },
  { description: "Resume a different session", name: "resume" },
  {
    description: "Reload keybindings, extensions, skills, prompts, and themes",
    name: "reload",
  },
  { description: "Quit pi", name: "quit" },
];
