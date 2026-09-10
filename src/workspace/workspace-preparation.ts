import { dirname } from 'node:path';
import { env } from '../config/env';
import { shellQuote } from './gh-cli-runner';
import { GitOperationError } from './git-operations';
import type { WorkspaceExecutionResult, WorkspaceRunner } from './runner';

const SAFE_WORKSPACE_ROOT = /^\/workspaces\/[A-Za-z0-9._-]+$/;
const EXIT_PREVIOUS_PUSH_FAILED = 32;
const EXIT_CLONE_FAILED = 31;

export interface WorkspacePreparationRequest {
  repositoryFullName: string;
  defaultBranch: string;
}

export interface WorkspacePreparationResult {
  repoDir: string;
  previousBranches: string[];
  output: string;
}

/**
 * Evita que un `GITHUB_CODESPACES_WORKDIR` mal configurado provoque un borrado
 * destructivo. Solo se permite limpiar carpetas dentro de /workspaces.
 */
export function assertSafeWorkspaceRoot(root: string): void {
  if (!SAFE_WORKSPACE_ROOT.test(root)) {
    throw new GitOperationError(
      `La carpeta de trabajo "${root}" no es segura para limpiar. Debe tener la forma /workspaces/<carpeta>.`,
      'COMMAND_FAILED',
    );
  }
}

export function workspaceRepoDir(root: string, repositoryFullName: string): string {
  const name = repositoryFullName.split('/').pop();
  if (!name) {
    throw new GitOperationError(`Repositorio no válido: ${repositoryFullName}`, 'COMMAND_FAILED');
  }
  return `${root.replace(/\/+$/, '')}/${name}`;
}

/**
 * Genera el script que se ejecuta dentro del Codespace para dejar el lugar de
 * trabajo listo: confirma y sube cualquier trabajo anterior, borra todo el
 * contenido de la carpeta de trabajo y clona el repositorio solicitado.
 */
export function buildWorkspacePreparationScript(
  root: string,
  repositoryFullName: string,
  defaultBranch: string,
): string {
  assertSafeWorkspaceRoot(root);
  const [owner, repoName] = repositoryFullName.split('/', 2);
  if (!owner || !repoName) {
    throw new GitOperationError(`Repositorio no válido: ${repositoryFullName}`, 'COMMAND_FAILED');
  }
  const repoDir = workspaceRepoDir(root, repositoryFullName);
  const repoUrl = `https://github.com/${owner}/${repoName}.git`;

  return [
    `export WORKSPACE_ROOT=${shellQuote(root)}`,
    `export REPO_DIR=${shellQuote(repoDir)}`,
    `export REPO_URL=${shellQuote(repoUrl)}`,
    `export DEFAULT_BRANCH=${shellQuote(defaultBranch)}`,
    `export AGENT_COMMIT_NAME=${shellQuote(env.agentCommitName)}`,
    `export AGENT_COMMIT_EMAIL=${shellQuote(env.agentCommitEmail)}`,
    'mkdir -p "$WORKSPACE_ROOT"',
    'gh auth setup-git >/dev/null 2>&1 || true',
    '',
    'echo "__PREVIOUS__"',
    'for dir in "$WORKSPACE_ROOT"/*/; do',
    '  [ -d "$dir/.git" ] || continue',
    '  [ -n "$(git -C "$dir" status --porcelain)" ] || continue',
    '  PREV_BRANCH="$(git -C "$dir" branch --show-current)"',
    '  [ -n "$PREV_BRANCH" ] || continue',
    '  git -C "$dir" config user.name "$AGENT_COMMIT_NAME"',
    '  git -C "$dir" config user.email "$AGENT_COMMIT_EMAIL"',
    '  git -C "$dir" add -A',
    '  git -C "$dir" commit -m "AUTO: cambios previos antes de preparar un trabajo nuevo" >/dev/null 2>&1 || true',
    '  if ! git -C "$dir" push -u origin "$PREV_BRANCH" >/dev/null 2>&1; then',
    '    echo "PREV_PUSH_FAILED:$PREV_BRANCH"',
    '    exit 32',
    '  fi',
    '  echo "PREV_PUSHED:$PREV_BRANCH"',
    'done',
    '',
    'echo "__CLEAN__"',
    'find "$WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    'echo "CLEANED"',
    '',
    'echo "__CLONE__"',
    'rm -rf "$REPO_DIR"',
    'if ! git clone --branch "$DEFAULT_BRANCH" --single-branch "$REPO_URL" "$REPO_DIR" >/dev/null 2>&1; then',
    '  echo "CLONE_FAILED"',
    '  exit 31',
    'fi',
    'git -C "$REPO_DIR" config user.name "$AGENT_COMMIT_NAME"',
    'git -C "$REPO_DIR" config user.email "$AGENT_COMMIT_EMAIL"',
    'echo "READY:$REPO_DIR"',
  ].join('\n');
}

export function parsePreparationOutput(
  result: WorkspaceExecutionResult,
  repoDir: string,
): WorkspacePreparationResult {
  const previousBranches = [...result.output.matchAll(/PREV_PUSHED:(\S+)/g)].map((match) => match[1]);
  const failedPush = result.output.match(/PREV_PUSH_FAILED:(\S+)/);

  if (failedPush) {
    throw new GitOperationError(
      `No pude subir los cambios de la implementación anterior en la rama ${failedPush[1]}, así que no he borrado nada para no perderlos. Revisa las credenciales del Codespace.`,
      'COMMAND_FAILED',
      result.output,
    );
  }
  if (result.timedOut) {
    throw new GitOperationError(
      'La preparación del lugar de trabajo superó el tiempo límite.',
      'TIMEOUT',
      result.output,
    );
  }
  if (result.exitCode === EXIT_PREVIOUS_PUSH_FAILED) {
    throw new GitOperationError(
      'No pude subir los cambios anteriores, así que no he borrado nada para no perderlos.',
      'COMMAND_FAILED',
      result.output,
    );
  }
  if (result.exitCode === EXIT_CLONE_FAILED || result.output.includes('CLONE_FAILED')) {
    throw new GitOperationError(
      'No pude clonar el repositorio en el Codespace. Revisa que el Codespace tenga acceso al repositorio.',
      'COMMAND_FAILED',
      result.output,
    );
  }
  if (result.exitCode !== 0 || !result.output.includes('READY:')) {
    throw new GitOperationError(
      `No pude preparar el lugar de trabajo: ${lastMeaningfulLine(result.output)}`,
      'COMMAND_FAILED',
      result.output,
    );
  }

  return { repoDir, previousBranches, output: result.output };
}

/**
 * Deja el lugar de trabajo limpio y con el repositorio solicitado recién
 * clonado. Antes de borrar, confirma y sube cualquier cambio pendiente.
 */
export async function prepareWorkspace(
  runner: WorkspaceRunner,
  codespaceName: string,
  root: string,
  request: WorkspacePreparationRequest,
): Promise<WorkspacePreparationResult> {
  assertSafeWorkspaceRoot(root);
  const repoDir = workspaceRepoDir(root, request.repositoryFullName);
  const script = buildWorkspacePreparationScript(root, request.repositoryFullName, request.defaultBranch);
  const result = await runner.execute(codespaceName, script, {
    // El `cd` inicial necesita una carpeta que ya exista; la raíz se crea dentro del script.
    workdir: dirname(root.replace(/\/+$/, '')) || '/workspaces',
    timeoutMs: env.codespaceGitTimeoutMs,
  });
  return parsePreparationOutput(result, repoDir);
}

export type { WorkspaceExecutionResult };

function lastMeaningfulLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('__') && !line.startsWith('PREV_') && line !== 'CLEANED' && line !== 'CLONED');
  return lines.at(-1) ?? 'sin detalle';
}
