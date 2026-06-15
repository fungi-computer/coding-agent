/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
  getEnvApiKey,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId,
} from "@mariozechner/pi-ai";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
} from "@mariozechner/pi-ai/oauth";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";

import { getAgentDir } from "../config.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export interface ApiKeyCredential {
  key: string;
  type: "api_key";
}

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T>;
}

export type AuthStorageData = Record<string, AuthCredential>;

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

interface LockResult<T> {
  next?: string;
  result: T;
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
  private data: AuthStorageData = {};
  private errors: Error[] = [];
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private runtimeOverrides = new Map<string, string>();

  private constructor(private storage: AuthStorageBackend) {
    this.reload();
  }

  static create(authPath?: string): AuthStorage {
    return new AuthStorage(
      new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")),
    );
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({
      next: JSON.stringify(data, null, 2),
      result: undefined,
    }));
    return AuthStorage.fromStorage(storage);
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  /**
   * Get credential for a provider.
   */
  get(provider: string): AuthCredential | undefined {
    return this.data[provider] ?? undefined;
  }

  /**
   * Get all credentials (for passing to getOAuthApiKey).
   */
  getAll(): AuthStorageData {
    return { ...this.data };
  }

  /**
   * Get API key for a provider.
   * Priority:
   * 1. Runtime override (CLI --api-key)
   * 2. API key from auth.json
   * 3. OAuth token from auth.json (auto-refreshed with locking)
   * 4. Environment variable
   * 5. Fallback resolver (models.json custom providers)
   */
  async getApiKey(
    providerId: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined> {
    // Runtime override takes highest priority
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      return runtimeKey;
    }

    const cred = this.data[providerId];

    if (cred?.type === "api_key") {
      return resolveConfigValue(cred.key);
    }

    if (cred?.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        // Unknown OAuth provider, can't get API key
        return undefined;
      }

      // Check if token needs refresh
      const needsRefresh = Date.now() >= cred.expires;

      if (needsRefresh) {
        // Use locked refresh to prevent race conditions
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) {
            return result.apiKey;
          }
        } catch (error) {
          this.recordError(error);
          // Refresh failed - re-read file to check if another instance succeeded
          this.reload();
          const updatedCred = this.data[providerId];

          if (
            updatedCred?.type === "oauth" &&
            Date.now() < updatedCred.expires
          ) {
            // Another instance refreshed successfully, use those credentials
            return provider.getApiKey(updatedCred);
          }

          // Refresh truly failed - return undefined so model discovery skips this provider
          // User can /login to re-authenticate (credentials preserved for retry)
          return undefined;
        }
      } else {
        // Token not expired, use current access token
        return provider.getApiKey(cred);
      }
    }

    // Fall back to environment variable
    const envKey = getEnvApiKey(providerId);
    if (envKey) return envKey;

    // Fall back to custom resolver (e.g., models.json custom providers)
    if (options?.includeFallback !== false) {
      return this.fallbackResolver?.(providerId) ?? undefined;
    }

    return undefined;
  }

  /**
   * Get all registered OAuth providers
   */
  getOAuthProviders() {
    return getOAuthProviders();
  }

  /**
   * Check if credentials exist for a provider in auth.json.
   */
  has(provider: string): boolean {
    return provider in this.data;
  }

  /**
   * Check if any form of auth is configured for a provider.
   * Unlike getApiKey(), this doesn't refresh OAuth tokens.
   */
  hasAuth(provider: string): boolean {
    if (this.runtimeOverrides.has(provider)) return true;
    if (this.data[provider]) return true;
    if (getEnvApiKey(provider)) return true;
    if (this.fallbackResolver?.(provider)) return true;
    return false;
  }

  /**
   * List all providers with credentials.
   */
  list(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Login to an OAuth provider.
   */
  async login(
    providerId: OAuthProviderId,
    callbacks: OAuthLoginCallbacks,
  ): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  /**
   * Logout from a provider.
   */
  logout(provider: string): void {
    this.remove(provider);
  }

  /**
   * Reload credentials from storage.
   */
  reload(): void {
    let content: string | undefined;
    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: undefined };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      this.loadError = error as Error;
      this.recordError(error);
    }
  }

  /**
   * Remove credential for a provider.
   */
  remove(provider: string): void {
    delete this.data[provider];
    this.persistProviderChange(provider, undefined);
  }

  /**
   * Remove a runtime API key override.
   */
  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /**
   * Set credential for a provider.
   */
  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persistProviderChange(provider, credential);
  }

  /**
   * Set a fallback resolver for API keys not found in auth.json or env vars.
   * Used for custom provider keys from models.json.
   */
  setFallbackResolver(
    resolver: (provider: string) => string | undefined,
  ): void {
    this.fallbackResolver = resolver;
  }

  /**
   * Set a runtime API key override (not persisted to disk).
   * Used for CLI --api-key flag.
   */
  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) {
      return {};
    }
    return JSON.parse(content) as AuthStorageData;
  }

  private persistProviderChange(
    provider: string,
    credential: AuthCredential | undefined,
  ): void {
    if (this.loadError) {
      return;
    }

    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { next: JSON.stringify(merged, null, 2), result: undefined };
      });
    } catch (error) {
      this.recordError(error);
    }
  }

  private recordError(error: unknown): void {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  /**
   * Refresh OAuth token with backend locking to prevent race conditions.
   * Multiple pi instances may try to refresh simultaneously when tokens expire.
   */
  private async refreshOAuthTokenWithLock(
    providerId: OAuthProviderId,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return null;
    }

    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      this.data = currentData;
      this.loadError = null;

      const cred = currentData[providerId];
      if (cred?.type !== "oauth") {
        return { result: null };
      }

      if (Date.now() < cred.expires) {
        return {
          result: { apiKey: provider.getApiKey(cred), newCredentials: cred },
        };
      }

      const oauthCreds: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(currentData)) {
        if (value.type === "oauth") {
          oauthCreds[key] = value;
        }
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) {
        return { result: null };
      }

      const merged: AuthStorageData = {
        ...currentData,
        [providerId]: { type: "oauth", ...refreshed.newCredentials },
      };
      this.data = merged;
      this.loadError = null;
      return { next: JSON.stringify(merged, null, 2), result: refreshed };
    });

    return result;
  }
}

export class FileAuthStorageBackend implements AuthStorageBackend {
  constructor(private authPath: string = join(getAgentDir(), "auth.json")) {}

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => void) | undefined;
    try {
      release = this.acquireLockSyncWithRetry(this.authPath);
      const current = existsSync(this.authPath)
        ? readFileSync(this.authPath, "utf-8")
        : undefined;
      const { next, result } = fn(current);
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      return result;
    } finally {
      if (release) {
        release();
      }
    }
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();

    let release: (() => Promise<void>) | undefined;
    let lockCompromised = false;
    let lockCompromisedError: Error | undefined;
    const throwIfCompromised = () => {
      if (lockCompromised) {
        throw (
          lockCompromisedError ?? new Error("Auth storage lock was compromised")
        );
      }
    };

    try {
      release = await lockfile.lock(this.authPath, {
        onCompromised: (err) => {
          lockCompromised = true;
          lockCompromisedError = err;
        },
        retries: {
          factor: 2,
          maxTimeout: 10000,
          minTimeout: 100,
          randomize: true,
          retries: 10,
        },
        stale: 30000,
      });

      throwIfCompromised();
      const current = existsSync(this.authPath)
        ? readFileSync(this.authPath, "utf-8")
        : undefined;
      const { next, result } = await fn(current);
      throwIfCompromised();
      if (next !== undefined) {
        writeFileSync(this.authPath, next, "utf-8");
        chmodSync(this.authPath, 0o600);
      }
      throwIfCompromised();
      return result;
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore unlock errors when lock is compromised.
        }
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

    throw (
      (lastError as Error) ?? new Error("Failed to acquire auth storage lock")
    );
  }

  private ensureFileExists(): void {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 0o600);
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { mode: 0o700, recursive: true });
    }
  }
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { next, result } = fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }

  async withLockAsync<T>(
    fn: (current: string | undefined) => Promise<LockResult<T>>,
  ): Promise<T> {
    const { next, result } = await fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }
}
