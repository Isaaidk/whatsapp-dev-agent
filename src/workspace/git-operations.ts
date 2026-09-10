import type { WorkspaceExecutionResult, WorkspaceRunner } from './runner';
import { env } from '../config/env';
import { shellQuote } from './gh-cli-runner';

export type GitOperationCode = 'NOT_A_REPOSITORY' | 'NO_CHANGES' | 'COMMAND_FAILED' | 'TIMEOUT';

export class GitOperationError extends Error {
  constructor(
    message: string,
    readonly code: GitOperationCode,
    readonly output = '',
  ) {
    super(message);
    this.name = 'GitOperationError';
  }
}

export interface WorkspaceGitState {
  isGitRepository: boolean;
  branch: string;
  changedFiles: string[];
}

export interface CommitAndPushRequest {
  branch: string;
  message: string;
}

export interface CommitAndPushResult {
  branch: string;
  commitSha: string;
  changedFiles: string[];
}

const EXIT_NOT_A_REPOSITORY = 20;
const EXIT_NO_CHANGES = 21;
const BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._\/-]{0,180})$/;

const INSPECT_SCRIPT = [
  'if [ ! -d .git ]; then echo "__NOT_A_REPO__"; exit 0; fi',
  'echo "__BRANCH__"',
  'git branch --show-current',
  'echo "__STATUS__"',
  'git status --porcelain',
].join('\n');

/** Genera un nombre de rama determinista del tipo `agent/20260910-141530`. */
export function buildAgentBranch(prefix = env.agentBranchPrefix, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
  return `${prefix}${stamp}`;
}

export function assertValidBranchName(branch: string): void {
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.endsWith('/')) {
    throw new GitOperationError(`Nombre de rama no válido: ${branch}`, 'COMMAND_FAILED');
  }
}

export async function inspectWorkspace(
  runner: WorkspaceRunner,
  codespaceName: string,
  workdir: string,
): Promise<WorkspaceGitState> {
  const result = await runner.execute(codespaceName, INSPECT_SCRIPT, {
    workdir,
    timeoutMs: env.codespaceGitTimeoutMs,
  });
  return parseInspectOutput(result);
}

export function parseInspectOutput(result: WorkspaceExecutionResult): WorkspaceGitState {
  if (result.output.includes('__NOT_A_REPO__')) {
    return { isGitRepository: false, branch: '', changedFiles: [] };
  }
  const branch = extractSection(result.output, '__BRANCH__', '__STATUS__');
  const status = extractSection(result.output, '__STATUS__', undefined);
  const changedFiles = status
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[A-Z?!]{1,2}\s+/, '').trim())
    .filter(Boolean);
  return {
    isGitRepository: result.exitCode === 0,
    branch: branch.trim(),
    changedFiles,
  };
}

/**
 * Ejecuta `git add -A`, `git commit` y `git push` dentro del Codespace.
 * El push usa la credencial de `gh` ya autenticada en ese Codespace.
 */
export async function commitAndPush(
  runner: WorkspaceRunner,
  codespaceName: string,
  workdir: string,
  request: CommitAndPushRequest,
): Promise<CommitAndPushResult> {
  assertValidBranchName(request.branch);
  const branchPayload = Buffer.from(request.branch, 'utf8').toString('base64');
  const messagePayload = Buffer.from(request.message, 'utf8').toString('base64');

  const script = [
    `export AGENT_BRANCH_B64=${shellQuote(branchPayload)}`,
    `export AGENT_COMMIT_MESSAGE_B64=${shellQuote(messagePayload)}`,
    `export AGENT_COMMIT_NAME=${shellQuote(env.agentCommitName)}`,
    `export AGENT_COMMIT_EMAIL=${shellQuote(env.agentCommitEmail)}`,
    'AGENT_BRANCH="$(printf %s "$AGENT_BRANCH_B64" | base64 -d)"',
    'AGENT_COMMIT_MESSAGE="$(printf %s "$AGENT_COMMIT_MESSAGE_B64" | base64 -d)"',
    'if [ ! -d .git ]; then echo "__NOT_A_REPO__"; exit 20; fi',
    'gh auth setup-git >/dev/null 2>&1 || true',
    'git config user.name "$AGENT_COMMIT_NAME"',
    'git config user.email "$AGENT_COMMIT_EMAIL"',
    'git checkout -B "$AGENT_BRANCH"',
    'git add -A',
    'if git diff --cached --quiet; then echo "__NO_CHANGES__"; exit 21; fi',
    'git commit -m "$AGENT_COMMIT_MESSAGE" || exit 22',
    'git push -u origin "$AGENT_BRANCH" || exit 23',
    'echo "__CHANGED_FILES__"',
    'git diff --name-only "HEAD~1" "HEAD"',
    'echo "__COMMIT_SHA__"',
    'git rev-parse HEAD',
  ].join('\n');

  const result = await runner.execute(codespaceName, script, {
    workdir,
    timeoutMs: env.codespaceGitTimeoutMs,
  });

  return parseCommitOutput(result, request.branch);
}

export function parseCommitOutput(
  result: WorkspaceExecutionResult,
  branch: string,
): CommitAndPushResult {
  if (result.timedOut) {
    throw new GitOperationError(
      `El comando de Git superó el tiempo límite dentro del Codespace.`,
      'TIMEOUT',
      result.output,
    );
  }
  if (result.exitCode === EXIT_NOT_A_REPOSITORY || result.output.includes('__NOT_A_REPO__')) {
    throw new GitOperationError(
      'El directorio de trabajo del Codespace no es un repositorio Git. Revisa CODESPACE_WORKDIR_TEMPLATE.',
      'NOT_A_REPOSITORY',
      result.output,
    );
  }
  if (result.exitCode === EXIT_NO_CHANGES || result.output.includes('__NO_CHANGES__')) {
    throw new GitOperationError(
      'No hay cambios pendientes que confirmar en el Codespace.',
      'NO_CHANGES',
      result.output,
    );
  }
  if (result.exitCode !== 0) {
    throw new GitOperationError(
      `Git falló dentro del Codespace: ${lastMeaningfulLine(result.output)}`,
      'COMMAND_FAILED',
      result.output,
    );
  }

  const changedFilesBlock = extractSection(result.output, '__CHANGED_FILES__', '__COMMIT_SHA__');
  const commitSha = extractSection(result.output, '__COMMIT_SHA__', undefined).trim().split('\n')[0]?.trim() ?? '';
  return {
    branch,
    commitSha,
    changedFiles: changedFilesBlock
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

export interface CodespacePullRequestResult {
  url: string;
  output: string;
}

/**
 * Abre el pull request con `gh` dentro del Codespace, reutilizando la sesión ya
 * autenticada allí. Sirve de respaldo cuando la GitHub App no tiene permiso de
 * Pull requests: write.
 */
export async function createPullRequestInCodespace(
  runner: WorkspaceRunner,
  codespaceName: string,
  workdir: string,
  request: { base: string; head: string; title: string; body: string },
): Promise<CodespacePullRequestResult> {
  assertValidBranchName(request.head);
  const titlePayload = Buffer.from(request.title, 'utf8').toString('base64');
  const bodyPayload = Buffer.from(request.body, 'utf8').toString('base64');

  const script = [
    `export PR_BASE=${shellQuote(request.base)}`,
    `export PR_HEAD=${shellQuote(request.head)}`,
    `export PR_TITLE_B64=${shellQuote(titlePayload)}`,
    `export PR_BODY_B64=${shellQuote(bodyPayload)}`,
    'PR_TITLE="$(printf %s "$PR_TITLE_B64" | base64 -d)"',
    'PR_BODY="$(printf %s "$PR_BODY_B64" | base64 -d)"',
    'gh auth setup-git >/dev/null 2>&1 || true',
    'if PR_OUTPUT="$(gh pr create --base "$PR_BASE" --head "$PR_HEAD" --title "$PR_TITLE" --body "$PR_BODY" 2>&1)"; then',
    '  echo "__PR_OK__"',
    '  echo "$PR_OUTPUT"',
    'else',
    '  echo "__PR_FAIL__"',
    '  echo "$PR_OUTPUT"',
    '  exit 41',
    'fi',
  ].join('\n');

  const result = await runner.execute(codespaceName, script, {
    workdir,
    timeoutMs: env.codespaceGitTimeoutMs,
  });

  const section = extractSection(result.output, '__PR_OK__', undefined).trim();
  if (result.exitCode !== 0 || !result.output.includes('__PR_OK__')) {
    const detail = extractSection(result.output, '__PR_FAIL__', undefined).trim() || lastMeaningfulLine(result.output);
    throw new GitOperationError(
      `No pude abrir el pull request desde el Codespace: ${detail}`,
      result.timedOut ? 'TIMEOUT' : 'COMMAND_FAILED',
      result.output,
    );
  }

  const url = section.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('http'))[0];
  if (!url) {
    throw new GitOperationError(
      `El pull request parece creado pero no pude leer su URL: ${section || 'sin salida'}`,
      'COMMAND_FAILED',
      result.output,
    );
  }
  return { url, output: section };
}

/** Convierte un error de Git en un mensaje accionable para el usuario. */
export function describeGitError(error: unknown): string {
  if (error instanceof GitOperationError) {
    if (error.code === 'NOT_A_REPOSITORY') {
      return `${error.message} Revisa CODESPACE_WORKDIR_TEMPLATE y que el Codespace tenga el repositorio clonado.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'error desconocido';
}

function extractSection(output: string, startMarker: string, endMarker: string | undefined): string {
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return '';
  const from = startIndex + startMarker.length;
  const endIndex = endMarker ? output.indexOf(endMarker, from) : -1;
  return output.slice(from, endIndex === -1 ? undefined : endIndex);
}

function lastMeaningfulLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('__'));
  return lines.at(-1) ?? 'sin detalle';
}
