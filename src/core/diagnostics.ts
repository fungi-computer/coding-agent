export interface ResourceCollision {
  loserPath: string;
  loserSource?: string;
  name: string; // skill name, command/tool/flag name, prompt name, theme name
  resourceType: "extension" | "prompt" | "skill" | "theme";
  winnerPath: string;
  winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
}

export interface ResourceDiagnostic {
  collision?: ResourceCollision;
  message: string;
  path?: string;
  type: "collision" | "error" | "warning";
}
