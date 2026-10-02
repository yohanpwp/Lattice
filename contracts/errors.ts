/** The tenant config could not be fetched. */
export class ConfigFetchError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ConfigFetchError";
    this.status = status;
  }
}

/** This client build is older than the backend's min_client_version. */
export class ClientTooOldError extends Error {
  readonly clientVersion: string;
  readonly minClientVersion: string;

  constructor(clientVersion: string, minClientVersion: string) {
    super(
      `Client ${clientVersion} is older than the minimum supported version ${minClientVersion}. Please update the app.`,
    );
    this.name = "ClientTooOldError";
    this.clientVersion = clientVersion;
    this.minClientVersion = minClientVersion;
  }
}
