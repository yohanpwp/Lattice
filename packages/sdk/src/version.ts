const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function parse(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Invalid version "${version}", expected MAJOR.MINOR.PATCH`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Returns <0, 0 or >0 like a standard comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when the client is at or above the backend's minimum version. */
export function isClientCompatible(clientVersion: string, minClientVersion: string): boolean {
  return compareVersions(clientVersion, minClientVersion) >= 0;
}

/** Supported major version for managed module specifications (^1.0.0). */
export const SUPPORTED_MODULE_MAJOR_VERSION = 1;

/**
 * Checks whether a module specification version complies with the client's supported-version policy.
 * Only specifications within major version 1 are supported by this client build.
 */
export function isModuleVersionCompatible(version: string): boolean {
  try {
    const [major] = parse(version);
    return major === SUPPORTED_MODULE_MAJOR_VERSION;
  } catch {
    return false;
  }
}
