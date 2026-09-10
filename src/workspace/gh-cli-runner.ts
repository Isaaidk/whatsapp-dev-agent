import { execFile } from 'node:child_process';
import type { WorkspaceCommandOptions, WorkspaceExecutionResult, WorkspaceRunner } from './runner';
import { codespaceWorkdirFor, env } from '../config/env';

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_EXIT_CODE = 124;

export interface GhCodespaceSummary {
  name: string;
  repository: string;
  state: string;
}

export class GhCliWorkspaceRunner implements WorkspaceRunner {
  constructor(private readonly timeoutMs = env.codespaceCommandTimeoutMs) {}

  async execute(
    codespaceName: string,
    command: string,
    options: WorkspaceCommandOptions = {},
  ): Promise<WorkspaceExecutionResult> {
    const workdir = options.workdir ?? env.githubCodespacesWorkdir;
    return this.runRemote(
      codespaceName,
      `cd ${shellQuote(workdir)} && ${command}`,
      options.timeoutMs ?? this.timeoutMs,
    );
  }

  async delegate(
    codespaceName: string,
    task: string,
    mode: 'plan' | 'implement' | 'review',
    options: WorkspaceCommandOptions = {},
  ): Promise<WorkspaceExecutionResult> {
    const command = mode === 'plan' ? env.codespacePlannerCommand : env.codespaceAgentCommand;
    if (!command) {
      throw new Error(`No hay comando configurado para el agente del Codespace (${mode}). Define CODESPACE_${mode === 'plan' ? 'PLANNER_' : ''}COMMAND.`);
    }
    const payload = Buffer.from(task, 'utf8').toString('base64');
    const remoteCommand = [
      `export AGENT_TASK_B64=${shellQuote(payload)}`,
      `export AGENT_MODE=${shellQuote(mode)}`,
      `export CODESPACE_COPILOT_MODEL=${shellQuote(env.codespaceCopilotModel)}`,
      `cd ${shellQuote(options.workdir ?? env.githubCodespacesWorkdir)}`,
      command,
    ].join(' && ');
    return this.runRemote(
      codespaceName,
      remoteCommand,
      options.timeoutMs ?? this.timeoutForMode(mode),
    );
  }

  async collectFile(codespaceName: string, remotePath: string, localPath: string): Promise<void> {
    await this.runGh(
      ['codespace', 'cp', '--codespace', codespaceName, `remote:${remotePath}`, localPath],
      env.codespaceCommandTimeoutMs,
      1024 * 1024,
    );
  }

  async listCodespaces(): Promise<GhCodespaceSummary[]> {
    const result = await this.runGh(
      ['codespace', 'list', '--json', 'name,repository,state', '--limit', '100'],
      env.codespaceCommandTimeoutMs,
      1024 * 1024,
    );
    if (result.exitCode !== 0) {
      throw new Error(`No pude listar los Codespaces: ${result.output.trim() || 'gh devolvió un error'}`);
    }
    return parseCodespaceList(result.output);
  }

  /**
   * Devuelve el Codespace configurado en GITHUB_CODESPACES_NAME. Es el único
   * lugar de trabajo del agente: todos los repositorios se clonan y se
   * implementan dentro de su carpeta de trabajo.
   */
  async resolveCodespace(_repositoryFullName: string): Promise<string | undefined> {
    return env.githubCodespacesName || undefined;
  }

  workdirFor(repositoryFullName?: string): string {
    return codespaceWorkdirFor(repositoryFullName);
  }

  private timeoutForMode(mode: 'plan' | 'implement' | 'review'): number {
    if (mode === 'plan') return env.codespacePlanTimeoutMs;
    if (mode === 'review') return env.codespaceReviewTimeoutMs;
    return env.codespaceImplementTimeoutMs;
  }

  private runRemote(
    codespaceName: string,
    remoteCommand: string,
    timeoutMs: number,
  ): Promise<WorkspaceExecutionResult> {
    // Importante: el comando va como un único argumento, sin envolverlo en
    // `bash -lc`. `gh codespace ssh` lo vuelve a unir con espacios, así que
    // envolverlo rompe el entrecomillado y el `cd` no se aplica: los comandos
    // acabarían ejecutándose en el HOME del Codespace.
    return this.runGh(
      ['codespace', 'ssh', '--codespace', codespaceName, '--', remoteCommand],
      timeoutMs,
      DEFAULT_MAX_BUFFER,
    );
  }

  private runGh(
    args: string[],
    timeoutMs: number,
    maxBuffer: number,
  ): Promise<WorkspaceExecutionResult> {
    return new Promise((resolve, reject) => {
      execFile(
        'gh',
        args,
        { timeout: timeoutMs, maxBuffer, env: githubCliEnvironment() },
        (error, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`;
          if (!error) {
            resolve({ output, exitCode: 0, timedOut: false });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (typeof failure.code === 'string' && ['ENOENT', 'EACCES'].includes(failure.code)) {
            reject(new Error('No encontré el CLI de GitHub (gh) en el PATH del servidor.'));
            return;
          }
          if (failure.killed || failure.signal === 'SIGTERM') {
            resolve({
              output: `${output}\n[tiempo agotado tras ${Math.round(timeoutMs / 1000)}s]`,
              exitCode: TIMEOUT_EXIT_CODE,
              timedOut: true,
            });
            return;
          }
          resolve({
            output,
            exitCode: typeof failure.code === 'number' ? failure.code : 1,
            timedOut: false,
          });
        },
      );
    });
  }
}

export function parseCodespaceList(rawOutput: string): GhCodespaceSummary[] {
  const start = rawOutput.indexOf('[');
  const end = rawOutput.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(rawOutput.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== 'string') return [];
      const repositoryField = record.repository as { fullName?: unknown; name?: unknown } | string | undefined;
      const repository = typeof repositoryField === 'string'
        ? repositoryField
        : typeof repositoryField?.fullName === 'string'
          ? repositoryField.fullName
          : typeof repositoryField?.name === 'string'
            ? repositoryField.name
            : '';
      return [{
        name: record.name,
        repository,
        state: typeof record.state === 'string' ? record.state : 'unknown',
      }];
    });
  } catch {
    return [];
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function githubCliEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'GITHUB_TOKEN' && key !== 'GH_TOKEN'),
  );
}