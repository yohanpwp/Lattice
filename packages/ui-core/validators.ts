import {
  validateAppConfig,
  validateDashboardLayout,
  validateEventEnvelope,
  validateFeatures,
  validatePluginManifest,
} from "./generated/standalone";
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

interface ValidationIssue {
  instancePath?: string;
  message?: string;
}

type GeneratedValidator = ((data: unknown) => boolean) & { errors?: ValidationIssue[] | null };

/**
 * Wraps a validator generated at build time (see scripts/gen.mjs). These are
 * plain functions: nothing is compiled at runtime, so they work under a strict
 * Content-Security-Policy that forbids eval / new Function.
 */
function makeAssert<T>(contract: string, validate: GeneratedValidator): (data: unknown) => T {
  return (data: unknown): T => {
    if (validate(data)) return data as T;
    const issues = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
    );
    throw new ContractError(contract, issues);
  };
}

export const assertAppConfig = makeAssert<AppConfig>("AppConfig", validateAppConfig);
export const assertFeatures = makeAssert<Features>("Features", validateFeatures);
export const assertDashboardLayout = makeAssert<DashboardLayout>("DashboardLayout", validateDashboardLayout);
export const assertPluginManifest = makeAssert<PluginManifest>("PluginManifest", validatePluginManifest);
export const assertEventEnvelope = makeAssert<EventEnvelope>("EventEnvelope", validateEventEnvelope);
