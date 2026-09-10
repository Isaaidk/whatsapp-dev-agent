export interface WorkspaceExecutionResult {
  output: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface WorkspaceCommandOptions {
  workdir?: string;
  timeoutMs?: number;
}

export interface WorkspaceRunner {
  execute(
    codespaceName: string,
    command: string,
    options?: WorkspaceCommandOptions,
  ): Promise<WorkspaceExecutionResult>;
  delegate(
    codespaceName: string,
    task: string,
    mode: 'plan' | 'implement' | 'review',
    options?: WorkspaceCommandOptions,
  ): Promise<WorkspaceExecutionResult>;
  collectFile(codespaceName: string, remotePath: string, localPath: string): Promise<void>;
  /** Devuelve el Codespace asociado al repositorio indicado, si existe. */
  resolveCodespace(repositoryFullName: string): Promise<string | undefined>;
}