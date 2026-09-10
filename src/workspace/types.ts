export interface WorkspaceRequest {
  repository: string;
  branch: string;
  task: string;
}

export interface WorkspacePlan {
  summary: string;
  files: string[];
  commands: string[];
  validations: string[];
  risks: string[];
}

export interface WorkspaceProvider {
  prepare(request: WorkspaceRequest): Promise<string>;
  apply(workspaceId: string, plan: WorkspacePlan): Promise<void>;
  runValidation(workspaceId: string, commands: string[]): Promise<string>;
  destroy(workspaceId: string): Promise<void>;
}