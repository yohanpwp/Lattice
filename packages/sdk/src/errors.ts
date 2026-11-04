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

/** A module specification version is not supported by this client build. */
export class IncompatibleModuleError extends Error {
  readonly moduleId: string;
  readonly version?: string;

  constructor(moduleId: string, version?: string, message?: string) {
    super(
      message ??
        `Module "${moduleId}" specification version "${version ?? "unknown"}" is not supported by this client build. Supported major version is 1.`,
    );
    this.name = "IncompatibleModuleError";
    this.moduleId = moduleId;
    this.version = version;
  }
}

/** A module setup or configuration request failed on the server. */
export class ModuleSetupError extends Error {
  readonly code: string;
  readonly created?: string[];
  readonly blockedOperations?: string[];
  readonly dataset?: string;

  constructor(
    message: string,
    code: string,
    options?: { created?: string[]; blockedOperations?: string[]; dataset?: string },
  ) {
    super(message);
    this.name = "ModuleSetupError";
    this.code = code;
    this.created = options?.created;
    this.blockedOperations = options?.blockedOperations;
    this.dataset = options?.dataset;
  }
}
