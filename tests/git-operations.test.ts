import { describe, expect, it } from 'vitest';
import {
  GitOperationError,
  assertValidBranchName,
  buildAgentBranch,
  commitAndPush,
  createPullRequestInCodespace,
  describeGitError,
  inspectWorkspace,
  parseCommitOutput,
  parseInspectOutput,
} from '../src/workspace/git-operations';
import type { WorkspaceCommandOptions, WorkspaceExecutionResult, WorkspaceRunner } from '../src/workspace/runner';

interface RunnerStub {
  runner: WorkspaceRunner;
  calls: Array<{ command: string; options?: WorkspaceCommandOptions }>;
}

function createRunner(result: Partial<WorkspaceExecutionResult> = {}): RunnerStub {
  const calls: RunnerStub['calls'] = [];
  const runner: WorkspaceRunner = {
    execute: async (_codespace, command, options) => {
      calls.push({ command, options });
      return { output: '', exitCode: 0, timedOut: false, ...result };
    },
    delegate: async () => ({ output: '', exitCode: 0 }),
    collectFile: async () => undefined,
    resolveCodespace: async () => 'codespace-1',
  };
  return { runner, calls };
}

function decodePayload(script: string, variable: string): string {
  const match = script.match(new RegExp(`export ${variable}='([^']+)'`));
  if (!match) throw new Error(`No encontré ${variable} en el script`);
  return Buffer.from(match[1], 'base64').toString('utf8');
}

describe('buildAgentBranch', () => {
  it('genera una rama con marca de tiempo', () => {
    expect(buildAgentBranch('agent/', new Date(2026, 8, 10, 14, 15, 30))).toBe('agent/20260910-141530');
  });

  it('acepta prefijos personalizados', () => {
    expect(buildAgentBranch('bot/', new Date(2026, 0, 2, 3, 4, 5))).toBe('bot/20260102-030405');
  });
});

describe('assertValidBranchName', () => {
  it('acepta nombres normales', () => {
    expect(() => assertValidBranchName('agent/20260910-141530')).not.toThrow();
  });

  it('rechaza inyección de comandos y rutas inválidas', () => {
    expect(() => assertValidBranchName('agent/$(rm -rf /)')).toThrow(GitOperationError);
    expect(() => assertValidBranchName('agent/x;false')).toThrow(GitOperationError);
    expect(() => assertValidBranchName('agent/a..b')).toThrow(GitOperationError);
    expect(() => assertValidBranchName('-rama')).toThrow(GitOperationError);
    expect(() => assertValidBranchName('agent/')).toThrow(GitOperationError);
  });
});

describe('commitAndPush', () => {
  it('ejecuta add, commit y push con la rama y el mensaje indicados', async () => {
    const { runner, calls } = createRunner({
      output: '__CHANGED_FILES__\nsrc/a.ts\nsrc/b.ts\n__COMMIT_SHA__\nabc1234\n',
    });

    const result = await commitAndPush(runner, 'codespace-1', '/workspaces/app', {
      branch: 'agent/20260910-141530',
      message: 'Añade: prueba',
    });

    expect(result).toEqual({
      branch: 'agent/20260910-141530',
      commitSha: 'abc1234',
      changedFiles: ['src/a.ts', 'src/b.ts'],
    });

    const script = calls[0].command;
    expect(script).toContain('git add -A');
    expect(script).toContain('git commit -m "$AGENT_COMMIT_MESSAGE"');
    expect(script).toContain('git push -u origin "$AGENT_BRANCH"');
    expect(script).toContain('gh auth setup-git');
    expect(decodePayload(script, 'AGENT_BRANCH_B64')).toBe('agent/20260910-141530');
    expect(decodePayload(script, 'AGENT_COMMIT_MESSAGE_B64')).toBe('Añade: prueba');
    expect(calls[0].options?.workdir).toBe('/workspaces/app');
  });

  it('rechaza ramas peligrosas antes de tocar el Codespace', async () => {
    const { runner, calls } = createRunner();

    await expect(
      commitAndPush(runner, 'codespace-1', '/workspaces/app', {
        branch: 'agent/x;rm -rf /',
        message: 'test',
      }),
    ).rejects.toThrow(GitOperationError);
    expect(calls).toHaveLength(0);
  });

  it('informa cuando no hay cambios que confirmar', async () => {
    const { runner } = createRunner({ exitCode: 21, output: '__NO_CHANGES__\n' });

    await expect(
      commitAndPush(runner, 'codespace-1', '/workspaces/app', { branch: 'agent/1', message: 'test' }),
    ).rejects.toMatchObject({ code: 'NO_CHANGES' });
  });

  it('informa cuando el directorio no es un repositorio Git', async () => {
    const { runner } = createRunner({ exitCode: 20, output: '__NOT_A_REPO__\n' });

    await expect(
      commitAndPush(runner, 'codespace-1', '/workspaces/app', { branch: 'agent/1', message: 'test' }),
    ).rejects.toMatchObject({ code: 'NOT_A_REPOSITORY' });
  });

  it('informa los fallos de Git con la última línea útil', async () => {
    const { runner } = createRunner({
      exitCode: 23,
      output: 'remote: Permission denied\nfatal: unable to access repository\n',
    });

    await expect(
      commitAndPush(runner, 'codespace-1', '/workspaces/app', { branch: 'agent/1', message: 'test' }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  });

  it('marca los timeouts explícitamente', async () => {
    const { runner } = createRunner({ exitCode: 124, timedOut: true, output: 'parcial' });

    await expect(
      commitAndPush(runner, 'codespace-1', '/workspaces/app', { branch: 'agent/1', message: 'test' }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('parseCommitOutput y parseInspectOutput', () => {
  it('extrae el commit y los archivos del formato de marcadores', () => {
    expect(
      parseCommitOutput(
        { output: '__CHANGED_FILES__\nREADME.md\n__COMMIT_SHA__\ndeadbeef\n', exitCode: 0 },
        'agent/1',
      ),
    ).toEqual({ branch: 'agent/1', commitSha: 'deadbeef', changedFiles: ['README.md'] });
  });

  it('detecta que el workdir no es un repositorio', () => {
    expect(parseInspectOutput({ output: '__NOT_A_REPO__\n', exitCode: 0 })).toEqual({
      isGitRepository: false,
      branch: '',
      changedFiles: [],
    });
  });

  it('lee la rama y los archivos modificados', () => {
    const state = parseInspectOutput({
      output: '__BRANCH__\nmain\n__STATUS__\n M src/a.ts\n?? src/b.ts\n',
      exitCode: 0,
    });

    expect(state.isGitRepository).toBe(true);
    expect(state.branch).toBe('main');
    expect(state.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('inspectWorkspace usa el workdir y devuelve el estado', async () => {
    const { runner, calls } = createRunner({
      output: '__BRANCH__\nagent/1\n__STATUS__\n M a.ts\n',
    });

    const state = await inspectWorkspace(runner, 'codespace-1', '/workspaces/app');

    expect(state.branch).toBe('agent/1');
    expect(calls[0].options?.workdir).toBe('/workspaces/app');
  });
});

describe('createPullRequestInCodespace', () => {
  it('devuelve la URL del pull request creado con gh', async () => {
    const { runner, calls } = createRunner({
      output: '__PR_OK__\nhttps://github.com/acme/app/pull/9\n',
    });

    const result = await createPullRequestInCodespace(runner, 'codespace-1', '/workspaces/app', {
      base: 'main',
      head: 'agent/20260910-141530',
      title: 'Añade: prueba',
      body: 'Descripción del cambio',
    });

    expect(result.url).toBe('https://github.com/acme/app/pull/9');
    const script = calls[0].command;
    expect(script).toContain('gh pr create --base "$PR_BASE" --head "$PR_HEAD"');
    expect(decodePayload(script, 'PR_TITLE_B64')).toBe('Añade: prueba');
    expect(decodePayload(script, 'PR_BODY_B64')).toBe('Descripción del cambio');
  });

  it('informa del error del Codespace cuando falla', async () => {
    const { runner } = createRunner({
      exitCode: 41,
      output: '__PR_FAIL__\nHTTP 403: Resource not accessible\n',
    });

    await expect(
      createPullRequestInCodespace(runner, 'codespace-1', '/workspaces/app', {
        base: 'main',
        head: 'agent/1',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(/No pude abrir el pull request desde el Codespace/);
  });

  it('falla si gh no devuelve ninguna URL', async () => {
    const { runner } = createRunner({ output: '__PR_OK__\nAlgo salió bien pero sin URL\n' });

    await expect(
      createPullRequestInCodespace(runner, 'codespace-1', '/workspaces/app', {
        base: 'main',
        head: 'agent/1',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(/no pude leer su URL/);
  });

  it('rechaza ramas peligrosas antes de tocar el Codespace', async () => {
    const { runner, calls } = createRunner();

    await expect(
      createPullRequestInCodespace(runner, 'codespace-1', '/workspaces/app', {
        base: 'main',
        head: 'agent/1;rm -rf /',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(GitOperationError);
    expect(calls).toHaveLength(0);
  });
});

describe('describeGitError', () => {
  it('sugiere revisar el workdir cuando no es un repositorio', () => {
    expect(describeGitError(new GitOperationError('no repo', 'NOT_A_REPOSITORY'))).toContain(
      'CODESPACE_WORKDIR_TEMPLATE',
    );
  });

  it('propaga el mensaje de otros errores', () => {
    expect(describeGitError(new Error('algo falló'))).toBe('algo falló');
    expect(describeGitError(undefined)).toBe('error desconocido');
  });
});
