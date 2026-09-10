import { describe, expect, it } from 'vitest';
import {
  assertSafeWorkspaceRoot,
  buildWorkspacePreparationScript,
  parsePreparationOutput,
  prepareWorkspace,
  workspaceRepoDir,
} from '../src/workspace/workspace-preparation';
import { GitOperationError } from '../src/workspace/git-operations';
import type { WorkspaceCommandOptions, WorkspaceExecutionResult, WorkspaceRunner } from '../src/workspace/runner';

const ROOT = '/workspaces/agent-workspace';

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

const successOutput = [
  '__PREVIOUS__',
  'PREV_PUSHED:agent/20260909-090000',
  '__CLEAN__',
  'CLEANED',
  '__CLONE__',
  'CLONED',
  `READY:${ROOT}/icodestudio`,
].join('\n');

describe('assertSafeWorkspaceRoot', () => {
  it('acepta carpetas dentro de /workspaces', () => {
    expect(() => assertSafeWorkspaceRoot('/workspaces/agent-workspace')).not.toThrow();
    expect(() => assertSafeWorkspaceRoot('/workspaces/agent.work-1')).not.toThrow();
  });

  it('rechaza rutas que borrarían demasiado', () => {
    expect(() => assertSafeWorkspaceRoot('/')).toThrow(GitOperationError);
    expect(() => assertSafeWorkspaceRoot('/workspaces')).toThrow(GitOperationError);
    expect(() => assertSafeWorkspaceRoot('/home/codespace')).toThrow(GitOperationError);
    expect(() => assertSafeWorkspaceRoot('/workspaces/agent-workspace/..')).toThrow(GitOperationError);
    expect(() => assertSafeWorkspaceRoot('/workspaces/a/b')).toThrow(GitOperationError);
    expect(() => assertSafeWorkspaceRoot('')).toThrow(GitOperationError);
  });
});

describe('workspaceRepoDir', () => {
  it('coloca cada repositorio en su propia carpeta', () => {
    expect(workspaceRepoDir(ROOT, 'Isaaidk/icodestudio')).toBe(`${ROOT}/icodestudio`);
    expect(workspaceRepoDir(`${ROOT}/`, 'Isaaidk/KITCHAN')).toBe(`${ROOT}/KITCHAN`);
  });

  it('rechaza repositorios sin nombre', () => {
    expect(() => workspaceRepoDir(ROOT, 'Isaaidk/')).toThrow(GitOperationError);
  });
});

describe('buildWorkspacePreparationScript', () => {
  it('sube lo anterior, limpia la carpeta y clona el repo pedido', () => {
    const script = buildWorkspacePreparationScript(ROOT, 'Isaaidk/icodestudio', 'main');

    expect(script).toContain(`export WORKSPACE_ROOT='${ROOT}'`);
    expect(script).toContain(`export REPO_DIR='${ROOT}/icodestudio'`);
    expect(script).toContain("export REPO_URL='https://github.com/Isaaidk/icodestudio.git'");
    expect(script).toContain("export DEFAULT_BRANCH='main'");
    expect(script).toContain('PREV_PUSH_FAILED');
    expect(script).toContain('exit 32');
    expect(script).toContain('find "$WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +');
    expect(script).toContain('git clone --branch "$DEFAULT_BRANCH" --single-branch "$REPO_URL" "$REPO_DIR"');
    expect(script).toContain('gh auth setup-git');
  });

  it('aborta sin borrar si no puede subir lo anterior', () => {
    const script = buildWorkspacePreparationScript(ROOT, 'Isaaidk/icodestudio', 'main');
    const cleanIndex = script.indexOf('__CLEAN__');
    const pushFailureIndex = script.indexOf('PREV_PUSH_FAILED');

    expect(pushFailureIndex).toBeGreaterThan(-1);
    expect(pushFailureIndex).toBeLessThan(cleanIndex);
  });

  it('rechaza una raíz insegura antes de generar nada', () => {
    expect(() => buildWorkspacePreparationScript('/', 'Isaaidk/icodestudio', 'main')).toThrow(
      GitOperationError,
    );
  });
});

describe('prepareWorkspace', () => {
  it('devuelve la carpeta del repo y las ramas anteriores subidas', async () => {
    const { runner, calls } = createRunner({ output: successOutput });

    const result = await prepareWorkspace(runner, 'codespace-1', ROOT, {
      repositoryFullName: 'Isaaidk/icodestudio',
      defaultBranch: 'main',
    });

    expect(result.repoDir).toBe(`${ROOT}/icodestudio`);
    expect(result.previousBranches).toEqual(['agent/20260909-090000']);
    // El `cd` inicial usa la carpeta padre, porque la raíz todavía puede no existir.
    expect(calls[0].options?.workdir).toBe('/workspaces');
  });

  it('aborta sin borrar cuando el push anterior falla', async () => {
    const { runner } = createRunner({
      exitCode: 32,
      output: '__PREVIOUS__\nPREV_PUSH_FAILED:agent/20260909-090000\n',
    });

    await expect(
      prepareWorkspace(runner, 'codespace-1', ROOT, {
        repositoryFullName: 'Isaaidk/icodestudio',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(/no he borrado nada para no perderlos/);
  });

  it('informa cuando el clonado falla', async () => {
    const { runner } = createRunner({ exitCode: 31, output: '__CLONE__\nCLONE_FAILED\n' });

    await expect(
      prepareWorkspace(runner, 'codespace-1', ROOT, {
        repositoryFullName: 'Isaaidk/icodestudio',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(/No pude clonar el repositorio/);
  });

  it('falla si el script termina sin confirmar que está listo', async () => {
    const { runner } = createRunner({ output: 'CLEANED\n' });

    await expect(
      prepareWorkspace(runner, 'codespace-1', ROOT, {
        repositoryFullName: 'Isaaidk/icodestudio',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(GitOperationError);
  });

  it('detecta el timeout', async () => {
    const { runner } = createRunner({ exitCode: 124, timedOut: true, output: 'parcial' });

    await expect(
      prepareWorkspace(runner, 'codespace-1', ROOT, {
        repositoryFullName: 'Isaaidk/icodestudio',
        defaultBranch: 'main',
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rechaza una raíz insegura antes de tocar el Codespace', async () => {
    const { runner, calls } = createRunner();

    await expect(
      prepareWorkspace(runner, 'codespace-1', '/home/codespace', {
        repositoryFullName: 'Isaaidk/icodestudio',
        defaultBranch: 'main',
      }),
    ).rejects.toThrow(GitOperationError);
    expect(calls).toHaveLength(0);
  });
});

describe('parsePreparationOutput', () => {
  it('no encuentra ramas anteriores cuando no había cambios', () => {
    const result = parsePreparationOutput(
      { output: '__PREVIOUS__\n__CLEAN__\nCLEANED\n__CLONE__\nCLONED\nREADY:/x\n', exitCode: 0 },
      '/x',
    );

    expect(result.previousBranches).toEqual([]);
  });
});
