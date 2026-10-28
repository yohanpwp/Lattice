import type {
  AppConfig,
  DashboardLayout,
  EventEnvelope,
  Features,
  PluginManifest,
  CheckoutRequest,
  Payment,
  SchemaDefinition,
  PageDefinition,
  WorkspaceUser,
  WorkspaceSetupRequest,
  WorkspaceInvitation,
} from "./generated/types";
import {
  validateAppConfig,
  validateDashboardLayout,
  validateEventEnvelope,
  validateFeatures,
  validatePluginManifest,
  validateCheckoutRequest,
  validatePayment,
  validateSchemaDefinition,
  validatePageDefinition,
  validateWorkspaceUser,
  validateWorkspaceSetupRequest,
  validateWorkspaceInvitation,
} from "./generated/standalone.mjs";

export interface ContractIssue {
  path: string;
  message: string;
}

export class ContractError extends Error {
  readonly contract: string;
  readonly issues: ContractIssue[];

  constructor(contract: string, issues: ContractIssue[]) {
    super(`Invalid ${contract}: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
    this.name = "ContractError";
    this.contract = contract;
    this.issues = issues;
  }
}

type StandaloneValidator = (value: unknown) => boolean;
type ValidatorModule = { errors?: Array<{ instancePath?: string; message?: string }> | null };

function makeAssert<T>(contract: string, validate: StandaloneValidator & ValidatorModule) {
  return (value: unknown): T => {
    if (validate(value)) return value as T;
    const issues = (validate.errors ?? []).map((error) => ({
      path: error.instancePath || "/",
      message: error.message || "is invalid",
    }));
    throw new ContractError(contract, issues);
  };
}

export const assertAppConfig = makeAssert<AppConfig>("AppConfig", validateAppConfig);
export const assertFeatures = makeAssert<Features>("Features", validateFeatures);
export const assertDashboardLayout = makeAssert<DashboardLayout>("DashboardLayout", validateDashboardLayout);
export const assertPluginManifest = makeAssert<PluginManifest>("PluginManifest", validatePluginManifest);
export const assertEventEnvelope = makeAssert<EventEnvelope>("EventEnvelope", validateEventEnvelope);
export const assertCheckoutRequest = makeAssert<CheckoutRequest>("CheckoutRequest", validateCheckoutRequest);
export const assertPayment = makeAssert<Payment>("Payment", validatePayment);
export const assertSchemaDefinition = makeAssert<SchemaDefinition>("SchemaDefinition", validateSchemaDefinition);
export const assertPageDefinition = makeAssert<PageDefinition>("PageDefinition", validatePageDefinition);
export const assertWorkspaceUser = makeAssert<WorkspaceUser>("WorkspaceUser", validateWorkspaceUser);
export const assertWorkspaceSetupRequest = makeAssert<WorkspaceSetupRequest>("WorkspaceSetupRequest", validateWorkspaceSetupRequest);
export const assertWorkspaceInvitation = makeAssert<WorkspaceInvitation>("WorkspaceInvitation", validateWorkspaceInvitation);
