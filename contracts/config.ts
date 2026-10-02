import { assertAppConfig, type AppConfig } from "@yourproduct/types";
import { ConfigFetchError } from "./errors";

/** Fetches and validates the public tenant config from GET {backendUrl}/v1/config. */
export async function fetchAppConfig(
  backendUrl: string,
  fetchImpl?: typeof fetch,
): Promise<AppConfig> {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const base = backendUrl.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await doFetch(`${base}/v1/config`, { headers: { Accept: "application/json" } });
  } catch (cause) {
    throw new ConfigFetchError(`Could not reach ${base}: ${String(cause)}`);
  }

  if (!res.ok) {
    throw new ConfigFetchError(`Config request failed with status ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ConfigFetchError("Config response was not valid JSON", res.status);
  }

  return assertAppConfig(body);
}
