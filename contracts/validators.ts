import Ajv from "ajv";
import {
  appConfigSchema,
  dashboardLayoutSchema,
  eventEnvelopeSchema,
  featuresSchema,
  pluginManifestSchema,
} from "./generated/schemas";
import type {
  AppConfig,
  DashboardLayout,
  EventEnvelope,
  Features,
  PluginManifest,
} from "./generated/types";

/** Thrown when data does not match a contract schema. */
export class ContractError extends Error {
  readonly issues: string[];

  constructor(contract: string, issues: string[]) {
    super(`Invalid ${contract}: ${issues.join("; ")}`);
    this.name = "ContractError";
    this.issues = issues;
  }
}

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });

function makeAssert<T>(contract: string, schema: object): (data: unknown) => T {
  const validate = ajv.compile(schema);
  return (data: unknown): T => {
    if (validate(data)) return data as T;
    const issues = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
    );
    throw new ContractError(contract, issues);
  };
}

export const assertAppConfig = makeAssert<AppConfig>("AppConfig", appConfigSchema);
export const assertFeatures = makeAssert<Features>("Features", featuresSchema);
export const assertDashboardLayout = makeAssert<DashboardLayout>(
  "DashboardLayout",
  dashboardLayoutSchema,
);
export const assertPluginManifest = makeAssert<PluginManifest>(
  "PluginManifest",
  pluginManifestSchema,
);
export const assertEventEnvelope = makeAssert<EventEnvelope>(
  "EventEnvelope",
  eventEnvelopeSchema,
);
