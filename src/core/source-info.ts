import type { PathMetadata } from "./package-manager.js";

export interface SourceInfo {
  baseDir?: string;
  origin: SourceOrigin;
  path: string;
  scope: SourceScope;
  source: string;
}
export type SourceOrigin = "package" | "top-level";

export type SourceScope = "project" | "temporary" | "user";

export function createSourceInfo(
  path: string,
  metadata: PathMetadata,
): SourceInfo {
  return {
    baseDir: metadata.baseDir,
    origin: metadata.origin,
    path,
    scope: metadata.scope,
    source: metadata.source,
  };
}

export function createSyntheticSourceInfo(
  path: string,
  options: {
    baseDir?: string;
    origin?: SourceOrigin;
    scope?: SourceScope;
    source: string;
  },
): SourceInfo {
  return {
    baseDir: options.baseDir,
    origin: options.origin ?? "top-level",
    path,
    scope: options.scope ?? "temporary",
    source: options.source,
  };
}
