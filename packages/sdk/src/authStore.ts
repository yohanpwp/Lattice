import { BaseAuthStore, type AuthRecord } from "pocketbase";
import type { StorageAdapter } from "./platform";

/** Async persistence failures are surfaced by login/logout and flush(). */
export class AuthPersistenceError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Could not ${operation} authentication state: ${String(cause)}`);
    this.name = "AuthPersistenceError";
    this.cause = cause;
  }
}

/** PocketBase auth state backed by an app supplied asynchronous storage API. */
export class PersistentAuthStore extends BaseAuthStore {
  readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(private readonly storage: StorageAdapter, private readonly key: string) {
    super();
    this.ready = this.restore();
  }

  override save(token: string, record?: AuthRecord): void {
    super.save(token, record);
    const serialized = JSON.stringify({ token, record: record ?? null });
    this.enqueue(() => this.storage.setItem(this.key, serialized));
  }

  override clear(): void {
    super.clear();
    this.enqueue(() => this.storage.removeItem(this.key));
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw new AuthPersistenceError("persist", failure);
    }
  }

  private async restore(): Promise<void> {
    try {
      const serialized = await this.storage.getItem(this.key);
      if (serialized === null) return;
      const state: unknown = JSON.parse(serialized);
      if (!state || typeof state !== "object" || typeof (state as { token?: unknown }).token !== "string") {
        throw new Error("Stored authentication state has an invalid shape");
      }
      const saved = state as { token: string; record?: AuthRecord | null };
      this.baseToken = saved.token;
      this.baseModel = saved.record ?? null;
    } catch (cause) {
      throw new AuthPersistenceError("restore", cause);
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.pending = this.pending
      .then(() => this.ready)
      .then(operation)
      .catch((cause) => {
        this.failure ??= cause;
      });
  }
}

export function createAuthStore(storage: StorageAdapter, key: string): PersistentAuthStore {
  return new PersistentAuthStore(storage, key);
}
