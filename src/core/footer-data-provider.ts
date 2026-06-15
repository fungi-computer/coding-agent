import { execFile, type ExecFileException, spawnSync } from "child_process";
import {
  existsSync,
  type FSWatcher,
  readFileSync,
  statSync,
  unwatchFile,
  watch,
  watchFile,
} from "fs";
import { dirname, join, resolve } from "path";

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
export type ReadonlyFooterDataProvider = Pick<
  FooterDataProvider,
  | "getAvailableProviderCount"
  | "getExtensionStatuses"
  | "getGitBranch"
  | "onBranchChange"
>;

interface GitPaths {
  commonGitDir: string;
  headPath: string;
  repoDir: string;
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
  private static readonly WATCH_DEBOUNCE_MS = 500;
  private availableProviderCount = 0;

  private branchChangeCallbacks = new Set<() => void>();
  private cachedBranch: null | string | undefined = undefined;
  private cwd: string;
  private disposed = false;
  private extensionStatuses = new Map<string, string>();
  private gitPaths: GitPaths | null | undefined = undefined;
  private headWatcher: FSWatcher | null = null;
  private refreshInFlight = false;
  private refreshPending = false;
  private refreshTimer: null | ReturnType<typeof setTimeout> = null;
  private reftableTablesListPath: null | string = null;
  private reftableTablesListWatcher: FSWatcher | null = null;
  private reftableWatcher: FSWatcher | null = null;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.gitPaths = findGitPaths(cwd);
    this.setupGitWatcher();
  }

  /** Internal: clear extension statuses */
  clearExtensionStatuses(): void {
    this.extensionStatuses.clear();
  }

  /** Internal: cleanup */
  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.headWatcher) {
      this.headWatcher.close();
      this.headWatcher = null;
    }
    if (this.reftableWatcher) {
      this.reftableWatcher.close();
      this.reftableWatcher = null;
    }
    if (this.reftableTablesListWatcher) {
      this.reftableTablesListWatcher.close();
      this.reftableTablesListWatcher = null;
    }
    if (this.reftableTablesListPath) {
      unwatchFile(this.reftableTablesListPath);
      this.reftableTablesListPath = null;
    }
    this.branchChangeCallbacks.clear();
  }

  /** Number of unique providers with available models (for footer display) */
  getAvailableProviderCount(): number {
    return this.availableProviderCount;
  }

  /** Extension status texts set via ctx.ui.setStatus() */
  getExtensionStatuses(): ReadonlyMap<string, string> {
    return this.extensionStatuses;
  }

  /** Current git branch, null if not in repo, "detached" if detached HEAD */
  getGitBranch(): null | string {
    if (this.cachedBranch === undefined) {
      this.cachedBranch = this.resolveGitBranchSync();
    }
    return this.cachedBranch;
  }

  /** Subscribe to git branch changes. Returns unsubscribe function. */
  onBranchChange(callback: () => void): () => void {
    this.branchChangeCallbacks.add(callback);
    return () => this.branchChangeCallbacks.delete(callback);
  }

  /** Internal: update available provider count */
  setAvailableProviderCount(count: number): void {
    this.availableProviderCount = count;
  }

  setCwd(cwd: string): void {
    if (this.cwd === cwd) {
      return;
    }

    this.cwd = cwd;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.headWatcher) {
      this.headWatcher.close();
      this.headWatcher = null;
    }
    if (this.reftableWatcher) {
      this.reftableWatcher.close();
      this.reftableWatcher = null;
    }
    if (this.reftableTablesListWatcher) {
      this.reftableTablesListWatcher.close();
      this.reftableTablesListWatcher = null;
    }
    if (this.reftableTablesListPath) {
      unwatchFile(this.reftableTablesListPath);
      this.reftableTablesListPath = null;
    }
    this.cachedBranch = undefined;
    this.gitPaths = findGitPaths(cwd);
    this.setupGitWatcher();
    this.notifyBranchChange();
  }

  /** Internal: set extension status */
  setExtensionStatus(key: string, text: string | undefined): void {
    if (text === undefined) {
      this.extensionStatuses.delete(key);
    } else {
      this.extensionStatuses.set(key, text);
    }
  }

  private notifyBranchChange(): void {
    for (const cb of this.branchChangeCallbacks) cb();
  }

  private async refreshGitBranchAsync(): Promise<void> {
    if (this.disposed) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }

    this.refreshInFlight = true;
    try {
      const nextBranch = await this.resolveGitBranchAsync();
      if (this.disposed) return;
      if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
        this.cachedBranch = nextBranch;
        this.notifyBranchChange();
        return;
      }
      this.cachedBranch = nextBranch;
    } finally {
      this.refreshInFlight = false;
      if (this.refreshPending && !this.disposed) {
        this.refreshPending = false;
        this.scheduleRefresh();
      }
    }
  }

  private async resolveGitBranchAsync(): Promise<null | string> {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        const branch = content.slice(16);
        return branch === ".invalid"
          ? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ??
              "detached")
          : branch;
      }
      return "detached";
    } catch {
      return null;
    }
  }

  private resolveGitBranchSync(): null | string {
    try {
      if (!this.gitPaths) return null;
      const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
      if (content.startsWith("ref: refs/heads/")) {
        const branch = content.slice(16);
        return branch === ".invalid"
          ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached")
          : branch;
      }
      return "detached";
    } catch {
      return null;
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshGitBranchAsync();
    }, FooterDataProvider.WATCH_DEBOUNCE_MS);
  }

  private setupGitWatcher(): void {
    if (!this.gitPaths) return;

    // Watch the directory containing HEAD, not HEAD itself.
    // Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
    // fs.watch on a file stops working after the inode changes.
    try {
      this.headWatcher = watch(
        dirname(this.gitPaths.headPath),
        (_eventType, filename) => {
          if (!filename || filename.toString() === "HEAD") {
            this.scheduleRefresh();
          }
        },
      );
    } catch {
      // Silently fail if we can't watch
    }

    // In reftable repos, branch switches update files in the reftable directory
    // instead of HEAD. Watch it separately so the footer picks up those changes.
    const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
    if (existsSync(reftableDir)) {
      try {
        this.reftableWatcher = watch(reftableDir, () => {
          this.scheduleRefresh();
        });
      } catch {
        // Silently fail if we can't watch
      }

      const tablesListPath = join(reftableDir, "tables.list");
      if (existsSync(tablesListPath)) {
        this.reftableTablesListPath = tablesListPath;
        try {
          this.reftableTablesListWatcher = watch(tablesListPath, () => {
            this.scheduleRefresh();
          });
        } catch {
          // Silently fail if we can't watch
        }
        watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
          if (
            current.mtimeMs !== previous.mtimeMs ||
            current.ctimeMs !== previous.ctimeMs ||
            current.size !== previous.size
          ) {
            this.scheduleRefresh();
          }
        });
      }
    }
  }
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            const commonDirPath = join(gitDir, "commondir");
            const commonGitDir = existsSync(commonDirPath)
              ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
              : gitDir;
            return { commonGitDir, headPath, repoDir: dir };
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { commonGitDir: gitPath, headPath, repoDir: dir };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir: string): Promise<null | string> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        cwd: repoDir,
        encoding: "utf8",
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          resolvePromise(null);
          return;
        }
        const branch = stdout.trim();
        resolvePromise(branch || null);
      },
    );
  });
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir: string): null | string {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch || null;
}
