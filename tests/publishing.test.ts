import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Orchestrator } from '../src/agent/orchestrator';
import { AgentJobRegistry } from '../src/agent/jobs';
import { createAgentContext, type AgentContext } from '../src/agent/context';
import type { ModelRouter } from '../src/agent/models/router';
import { RepositoryManager } from '../src/github/repository-manager';
import type { GitHubClient, GitHubRepository } from '../src/github/types';
import { GitHubClientError } from '../src/github/types';
import type { RepositoryContext } from '../src/github/repository-context';
import type { IncomingMessage } from '../src/channels/types';
import type { WorkspaceExecutionResult, WorkspaceRunner } from '../src/workspace/runner';
import { env } from '../src/config/env';

const repository: GitHubRepository = {
  id: 1,
  name: 'app',
  fullName: 'acme/app',
  owner: 'acme',
  defaultBranch: 'main',
  description: 'App de prueba',
  language: 'TypeScript',
  visibility: 'private',
  private: true,
};

const tree = [
  { path: 'src/server.ts', type: 'blob' as const },
  { path: 'package.json', type: 'blob' as const },
  { path: 'tests/app.test.ts', type: 'blob' as const },
];

function createGitHubClient(): GitHubClient {
  return {
    listRepositories: async () => [repository],
    getRepository: async () => repository,
    getRepositoryTree: async () => tree,
    getFile: async () => ({ path: 'README.md', content: '# App', encoding: 'utf-8' }),
    searchCode: async () => [],
    getReadme: async () => ({ path: 'README.md', content: '# App', encoding: 'utf-8' }),
    getBranch: async () => ({ name: 'main', protected: false }),
    listBranches: async () => [{ name: 'main', protected: false }],
    getPullRequests: async () => [],
    getIssues: async () => [],
    createPullRequest: async (_owner, _repository, title, head, base) => ({
      number: 7,
      title,
      url: 'https://github.com/acme/app/pull/7',
      head,
      base,
    }),
  };
}

interface RunnerHarness {
  runner: WorkspaceRunner;
  commands: string[];
  notifications: string[];
  files: string[];
  delegations: string[];
}

const PREPARED_REPO_DIR = '/workspaces/agent-workspace/app';

function createRunner(overrides: { delegateResult?: WorkspaceExecutionResult } = {}): RunnerHarness {
  const commands: string[] = [];
  const notifications: string[] = [];
  const files: string[] = [];
  const delegations: string[] = [];
  const runner: WorkspaceRunner = {
    execute: async (_codespace, command) => {
      commands.push(command);
      if (command.includes('__CLONE__')) {
        return {
          output: [
            '__PREVIOUS__',
            'PREV_PUSHED:agent/20260909-090000',
            '__CLEAN__',
            'CLEANED',
            '__CLONE__',
            'CLONED',
            `READY:${PREPARED_REPO_DIR}`,
          ].join('\n'),
          exitCode: 0,
        };
      }
      if (command.includes('git add -A')) {
        return { output: '__CHANGED_FILES__\nREADME.md\n__COMMIT_SHA__\nabc1234\n', exitCode: 0 };
      }
      return { output: '', exitCode: 0 };
    },
    delegate: async (_codespace, task) => {
      delegations.push(task);
      return overrides.delegateResult ?? {
        output: 'Implementé los cambios solicitados.\nEjecuté las pruebas: 3 pasan.',
        exitCode: 0,
      };
    },
    collectFile: async () => undefined,
    resolveCodespace: async () => 'codespace-1',
  };
  return { runner, commands, notifications, files, delegations };
}

function createMessage(text: string): IncomingMessage {
  return {
    channel: 'telegram',
    userId: 'user-1',
    senderId: 'user-1',
    messageId: 'msg-1',
    timestamp: '1',
    text,
    chatId: 'chat-1',
  };
}

function createOrchestrator(
  harness: RunnerHarness,
  modelRouter?: ModelRouter,
  client: GitHubClient = createGitHubClient(),
) {
  const router = modelRouter ?? ({ generate: vi.fn().mockResolvedValue('Narrativa del modelo') } as unknown as ModelRouter);
  const jobs = new AgentJobRegistry({
    notify: async (_chatId, text) => {
      harness.notifications.push(text);
    },
    sendFile: async (_chatId, filePath) => {
      harness.files.push(filePath);
    },
  });
  return new Orchestrator(
    new RepositoryManager(client),
    router,
    undefined,
    harness.runner,
    jobs,
  );
}

function createPendingContext(status: AgentContext['pendingChange'] extends undefined ? never : NonNullable<AgentContext['pendingChange']>['status'] = 'awaiting_approval'): AgentContext {
  const context = createAgentContext();
  context.user = { id: 'user-1' };
  context.currentRepository = 'acme/app';
  context.selectedBranch = 'main';
  context.pendingChange = {
    request: 'actualiza el README',
    plan: '1. Editar README\n2. Ejecutar tests',
    status,
    branch: 'agent/20260910-120000',
    baseBranch: 'main',
  };
  return context;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('La condición no se cumplió a tiempo');
}

const originalAllowWrite = env.allowWriteOperations;
const originalDeepSeekKey = env.deepseekApiKey;

beforeEach(() => {
  env.allowWriteOperations = false;
  // Los tests no deben depender de la clave real del .env: sin clave se
  // ejercita el camino de delegación al Codespace, que es el simulado aquí.
  env.deepseekApiKey = '';
});

afterEach(() => {
  env.allowWriteOperations = originalAllowWrite;
  env.deepseekApiKey = originalDeepSeekKey;
});

describe('comando analiza', () => {
  it('devuelve el informe determinista aunque el modelo falle', async () => {
    const harness = createRunner();
    const failingRouter = {
      generate: vi.fn().mockRejectedValue(new Error('modelo caído')),
    } as unknown as ModelRouter;
    const orchestrator = createOrchestrator(harness, failingRouter);

    const response = await orchestrator.handleMessage(createMessage('analiza el proyecto'), createPendingContext());

    expect(response).toContain('Informe del proyecto acme/app');
    expect(response).toContain('Stack detectado');
    expect(response).toContain('No pude generar la narrativa del modelo');
  });

  it('añade la narrativa del modelo cuando está disponible', async () => {
    const orchestrator = createOrchestrator(createRunner());

    const response = await orchestrator.handleMessage(createMessage('analiza'), createPendingContext());

    expect(response).toContain('Informe del proyecto acme/app');
    expect(response).toContain('Análisis del modelo:');
    expect(response).toContain('Narrativa del modelo');
  });

  it('analiza el repositorio indicado en el propio mensaje', async () => {
    const harness = createRunner();
    const orchestrator = createOrchestrator(harness);
    const context = createAgentContext();
    context.user = { id: 'user-1' };
    context.currentRepository = 'acme/otro';

    const response = await orchestrator.handleMessage(createMessage('analiza el repositorio app'), context);

    expect(context.currentRepository).toBe('acme/app');
    expect(response).toContain('Informe del proyecto acme/app');
  });
});

describe('aceptarcambiosysubiragthub', () => {
  it('pide seleccionar repositorio si no hay ninguno', async () => {
    const orchestrator = createOrchestrator(createRunner());
    const context = createAgentContext();
    context.user = { id: 'user-1' };

    const response = await orchestrator.handleMessage(createMessage('aceptarcambiosysubiragthub'), context);

    expect(response).toContain('Primero selecciona un repositorio');
  });

  it('explica que la escritura está desactivada', async () => {
    const orchestrator = createOrchestrator(createRunner());

    const response = await orchestrator.handleMessage(
      createMessage('aceptarcambiosysubiragthub'),
      createPendingContext(),
    );

    expect(response).toContain('ALLOW_WRITE_OPERATIONS=true');
  });

  it('implementa, hace add/commit/push y abre el pull request', async () => {
    env.allowWriteOperations = true;
    const harness = createRunner();
    const orchestrator = createOrchestrator(harness);
    const context = createPendingContext();

    const immediate = await orchestrator.handleMessage(createMessage('aceptarcambiosysubiragthub'), context);

    expect(immediate).toContain('En marcha sobre acme/app');
    await waitFor(() => context.pendingChange?.status === 'published');

    expect(context.pendingChange).toMatchObject({
      status: 'published',
      branch: 'agent/20260910-120000',
      commitSha: 'abc1234',
      changedFiles: ['README.md'],
    });

    const pushCommand = harness.commands.find((command) => command.includes('git add -A'));
    expect(pushCommand).toBeDefined();
    expect(pushCommand).toContain('git push -u origin "$AGENT_BRANCH"');

    const preparationCommand = harness.commands[0];
    expect(preparationCommand).toContain('__CLONE__');
    expect(preparationCommand).toContain('find "$WORKSPACE_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +');
    expect(preparationCommand).toContain('git clone --branch "$DEFAULT_BRANCH" --single-branch "$REPO_URL" "$REPO_DIR"');

    const joined = harness.notifications.join('\n');
    expect(joined).toContain('Preparando codespace-1');
    expect(joined).toContain('Subí los cambios pendientes de la implementación anterior');
    expect(joined).toContain('Lugar de trabajo limpio');
    expect(joined).toContain('Implementando en el Codespace codespace-1');
    expect(joined).toContain('Commit abc1234 creado');
    expect(joined).toContain('Cambios subidos a acme/app');
    expect(harness.files).toHaveLength(1);
    expect(harness.delegations[0]).toContain('No hagas commit');
    expect(harness.commands.some((command) => command.includes('gh pr create'))).toBe(false);
  });

  it('acepta el comando escrito con espacios', async () => {
    env.allowWriteOperations = true;
    const harness = createRunner();
    const orchestrator = createOrchestrator(harness);
    const context = createPendingContext();

    const response = await orchestrator.handleMessage(
      createMessage('aceptar cambios y subir a github'),
      context,
    );

    expect(response).toContain('En marcha sobre acme/app');
    await waitFor(() => context.pendingChange?.status === 'published');
  });

  it('avisa y no publica si el agente falla al implementar', async () => {
    env.allowWriteOperations = true;
    const harness = createRunner({
      delegateResult: { output: 'error de compilación', exitCode: 1 },
    });
    const orchestrator = createOrchestrator(harness);
    const context = createPendingContext();

    await orchestrator.handleMessage(createMessage('aceptarcambiosysubiragthub'), context);
    await waitFor(() => context.pendingChange?.status === 'failed');

    expect(context.pendingChange?.status).toBe('failed');
    expect(harness.commands.some((command) => command.includes('git push -u origin "$AGENT_BRANCH"'))).toBe(false);
    expect(harness.notifications.join('\n')).toContain('No pude completar la implementación');
  });

  it('evita lanzar dos tareas a la vez en el mismo chat', async () => {
    env.allowWriteOperations = true;
    const harness = createRunner();
    const orchestrator = createOrchestrator(harness);
    const context = createPendingContext();

    const first = await orchestrator.handleMessage(createMessage('aceptarcambiosysubiragthub'), context);
    const second = await orchestrator.handleMessage(createMessage('aceptarcambiosysubiragthub'), context);

    expect(first).toContain('En marcha sobre acme/app');
    expect(second).toMatch(/Ya hay una tarea en curso|Ya estoy subiendo/);
    await waitFor(() => context.pendingChange?.status === 'published');
  });
});

describe('estado y capacidades', () => {
  it('refleja el estado real de la escritura', async () => {
    const orchestrator = createOrchestrator(createRunner());

    const status = await orchestrator.handleMessage(createMessage('/status'), createPendingContext());
    const capabilities = await orchestrator.handleMessage(createMessage('/habilidades'), createPendingContext());

    expect(status).toContain('Permisos de escritura: deshabilitados');
    expect(status).toContain('Cambio pendiente: awaiting_approval');
    expect(capabilities).toContain('ALLOW_WRITE_OPERATIONS=true');
  });
});

describe('informe de contexto', () => {
  it('describe el contexto tras analizar', async () => {
    const orchestrator = createOrchestrator(createRunner());
    const context = createPendingContext();

    await orchestrator.handleMessage(createMessage('analiza'), context);
    const description = await orchestrator.handleMessage(createMessage('/context'), context);

    expect(description).toContain('Repositorio: acme/app');
    expect(description).toContain('Archivos detectados: 3');
  });
});
