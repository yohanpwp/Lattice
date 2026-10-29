export * from "./generated/types";
export * from "./generated/schemas";
export * from "./validators";

export interface WorkspaceModule {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  enabled: boolean;
  dataset_id?: string;
  page_ids?: string[];
  feature_flag?: string;
}
