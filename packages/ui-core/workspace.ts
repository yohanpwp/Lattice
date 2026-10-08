import type { StorageAdapter } from "@lattice/sdk";

const STORAGE_KEY = "yp_workspace_url";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type NormalizeResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Turns whatever a person typed into a safe backend origin.
 *  - "acme.app.example.com"      -> https://acme.app.example.com
 *  - "localhost:8090"            -> http://localhost:8090 (local development only)
 *  - http:// to a non-local host -> rejected (tokens must not cross the network in clear text)
 *  - credentials in the URL      -> rejected
 * Paths, queries and fragments are dropped; only the origin is kept.
 */
export function normalizeWorkspaceUrl(input: string): NormalizeResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Enter your workspace address." };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    if (!hasScheme && LOCAL_HOSTS.has(url.hostname)) url = new URL(`http://${trimmed}`);
  } catch {
    return { ok: false, error: "That does not look like a valid address." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The address must start with https://." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "Do not include a username or password in the address." };
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    return { ok: false, error: "Use https:// for your workspace address." };
  }

  return { ok: true, url: url.origin };
}

/** The workspace saved by a previous run, or null if none (or the saved value is no longer valid). */
export async function loadSavedWorkspace(storage: StorageAdapter): Promise<string | null> {
  const saved = await storage.getItem(STORAGE_KEY).catch(() => null);
  if (!saved) return null;
  const result = normalizeWorkspaceUrl(saved);
  return result.ok ? result.url : null;
}

export function saveWorkspace(storage: StorageAdapter, url: string): Promise<void> {
  return storage.setItem(STORAGE_KEY, url);
}

export function forgetWorkspace(storage: StorageAdapter): Promise<void> {
  return storage.removeItem(STORAGE_KEY);
}
