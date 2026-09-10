import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekClient, DeepSeekError } from '../src/agent/models/providers/DeepSeekClient';
import { DeepSeekProvider } from '../src/agent/models/providers/DeepSeekProvider';
import { ModelProviderError } from '../src/agent/models/provider';
import { createConfiguredModelProvider } from '../src/agent/models/provider-factory';
import { env } from '../src/config/env';
import {
  buildCoderTools,
  isBlockedCommand,
  isPathInsideWorkdir,
  parseToolArguments,
  runDeepSeekCodingTask,
  truncateToolOutput,
} from '../src/workspace/deepseek-coder';
import type { WorkspaceCommandOptions, WorkspaceExecutionResult, WorkspaceRunner } from '../src/workspace/runner';

const originalProvider = env.modelProvider;
const originalApiKey = env.deepseekApiKey;

afterEach(() => {
  env.modelProvider = originalProvider;
  env.deepseekApiKey = originalApiKey;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeepSeekClient', () => {
  it('devuelve el contenido de la respuesta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'Hola desde DeepSeek' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new DeepSeekClient('clave-de-prueba', 'https://api.deepseek.com', 5000);
    const result = await client.chat([{ role: 'user', content: 'hola' }]);

    expect(result.content).toBe('Hola desde DeepSeek');
    expect(result.toolCalls).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer clave-de-prueba');
  });

  it('devuelve las llamadas a herramientas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
        },
      }],
    })));

    const client = new DeepSeekClient('clave', 'https://api.deepseek.com', 5000);
    const result = await client.chat([{ role: 'user', content: 'hola' }], { tools: buildCoderTools() });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('list_files');
  });

  it('falla sin clave sin llegar a la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new DeepSeekClient('', 'https://api.deepseek.com').chat([{ role: 'user', content: 'x' }]))
      .rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('oculta la clave en los mensajes de error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('invalid key clave-secreta-123', { status: 401 }),
    ));

    const client = new DeepSeekClient('clave-secreta-123', 'https://api.deepseek.com');
    await expect(client.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/clave oculta/);
  });

  it('marca el timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('abortado');
          error.name = 'AbortError';
          reject(error);
        });
      })));

    const client = new DeepSeekClient('clave', 'https://api.deepseek.com', 5);
    await expect(client.chat([{ role: 'user', content: 'x' }], { timeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rechaza respuestas vacías', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '' } }] })));

    const client = new DeepSeekClient('clave', 'https://api.deepseek.com');
    await expect(client.chat([{ role: 'user', content: 'x' }]))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });
});

describe('DeepSeekProvider', () => {
  it('traduce los errores del cliente al contrato de modelos', async () => {
    const client = new DeepSeekClient('clave', 'https://api.deepseek.com');
    vi.spyOn(client, 'chat').mockRejectedValue(new DeepSeekError('sin cuota', 'UPSTREAM_ERROR', 429));
    const provider = new DeepSeekProvider(client);

    await expect(provider.generate({ taskType: 'GENERAL', systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toBeInstanceOf(ModelProviderError);
  });

  it('devuelve el texto del modelo', async () => {
    const client = new DeepSeekClient('clave', 'https://api.deepseek.com');
    vi.spyOn(client, 'chat').mockResolvedValue({ content: '  respuesta  ', toolCalls: [] });
    const provider = new DeepSeekProvider(client);

    await expect(provider.generate({ taskType: 'ARCHITECTURE', systemPrompt: 's', userPrompt: 'u' }))
      .resolves.toBe('respuesta');
  });
});

describe('createConfiguredModelProvider', () => {
  it('crea el proveedor de DeepSeek', () => {
    env.modelProvider = 'deepseek';
    env.deepseekApiKey = 'clave';
    expect(createConfiguredModelProvider()).toBeInstanceOf(DeepSeekProvider);
  });

  it('rechaza proveedores desconocidos', () => {
    env.modelProvider = 'otro';
    expect(() => createConfiguredModelProvider()).toThrow(/MODEL_PROVIDER no soportado/);
  });
});

describe('ayudantes del agente DeepSeek', () => {
  it('bloquea comandos destructivos', () => {
    expect(isBlockedCommand('rm -rf /')).toBe(true);
    expect(isBlockedCommand('mkfs.ext4 /dev/sda1')).toBe(true);
    expect(isBlockedCommand('npm test')).toBe(false);
    expect(isBlockedCommand('git status')).toBe(false);
  });

  it('solo acepta rutas dentro del repositorio', () => {
    expect(isPathInsideWorkdir('src/index.ts')).toBe(true);
    expect(isPathInsideWorkdir('./README.md')).toBe(true);
    expect(isPathInsideWorkdir('/etc/passwd')).toBe(false);
    expect(isPathInsideWorkdir('../../secreto')).toBe(false);
    expect(isPathInsideWorkdir('')).toBe(false);
  });

  it('trunca salidas largas', () => {
    expect(truncateToolOutput('a'.repeat(50), 10)).toContain('truncada');
    expect(truncateToolOutput('corto', 10)).toBe('corto');
  });

  it('tolera argumentos inválidos de herramientas', () => {
    expect(parseToolArguments('{ roto')).toEqual({});
    expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
  });
});

interface RunnerStub {
  runner: WorkspaceRunner;
  calls: Array<{ command: string; options?: WorkspaceCommandOptions }>;
}

function createRunner(handler: (command: string) => Partial<WorkspaceExecutionResult>): RunnerStub {
  const calls: RunnerStub['calls'] = [];
  const runner: WorkspaceRunner = {
    execute: async (_codespace, command, options) => {
      calls.push({ command, options });
      return { output: '', exitCode: 0, timedOut: false, ...handler(command) };
    },
    delegate: async () => ({ output: '', exitCode: 0 }),
    collectFile: async () => undefined,
    resolveCodespace: async () => 'codespace-1',
  };
  return { runner, calls };
}

describe('runDeepSeekCodingTask', () => {
  it('lee, escribe y termina siguiendo las herramientas', async () => {
    const { runner, calls } = createRunner((command) => {
      if (command.includes('git ls-files')) return { output: 'src/index.ts\nREADME.md\n' };
      if (command.includes('head -c')) return { output: '# Proyecto\n' };
      return { output: 'ESCRITO 12 bytes\n' };
    });

    const responses = [
      { content: '', toolCalls: [{ id: '1', type: 'function' as const, function: { name: 'list_files', arguments: '{}' } }] },
      { content: '', toolCalls: [{ id: '2', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
      { content: '', toolCalls: [{ id: '3', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"README.md","content":"# Proyecto\\n\\nNuevo"}' } }] },
      { content: '', toolCalls: [{ id: '4', type: 'function' as const, function: { name: 'finish', arguments: '{"summary":"Actualicé el README."}' } }] },
    ];
    let index = 0;
    const client = { chat: vi.fn().mockImplementation(async () => responses[Math.min(index++, responses.length - 1)]) };

    const notificaciones: string[] = [];
    const result = await runDeepSeekCodingTask(
      {
        runner,
        codespaceName: 'codespace-1',
        workdir: '/workspaces/agent-workspace/app',
        task: 'Actualiza el README',
        notify: async (text) => {
          notificaciones.push(text);
        },
      },
      client as never,
    );

    expect(result.summary).toBe('Actualicé el README.');
    expect(result.filesTouched).toEqual(['README.md']);
    expect(result.actions[0]).toContain('list_files');
    expect(notificaciones.join('\n')).toContain('✏️ Editado README.md');
    expect(calls.some((call) => call.command.includes('base64 -d > '))).toBe(true);
    expect(calls.every((call) => call.options?.workdir === '/workspaces/agent-workspace/app')).toBe(true);
  });

  it('rechaza escribir fuera del repositorio', async () => {
    const { runner, calls } = createRunner(() => ({ output: '' }));
    const responses = [
      { content: '', toolCalls: [{ id: '1', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"/etc/passwd","content":"x"}' } }] },
      { content: 'Listo.', toolCalls: [] },
    ];
    let index = 0;
    const client = { chat: vi.fn().mockImplementation(async () => responses[Math.min(index++, 1)]) };

    const result = await runDeepSeekCodingTask(
      { runner, codespaceName: 'c', workdir: '/workspaces/agent-workspace/app', task: 't' },
      client as never,
    );

    expect(result.filesTouched).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('falla si el modelo agota los pasos', async () => {
    const { runner } = createRunner((command) => ({ output: command.includes('ls-files') ? 'a.ts\n' : '' }));
    const client = {
      chat: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [{ id: 'x', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
      }),
    };

    await expect(
      runDeepSeekCodingTask(
        { runner, codespaceName: 'c', workdir: '/workspaces/agent-workspace/app', task: 't', maxSteps: 2 },
        client as never,
      ),
    ).rejects.toThrow(/límite de 2 pasos/);
  });

  it('propaga las acciones de shell y bloquea las peligrosas', async () => {
    const { runner, calls } = createRunner(() => ({ output: 'ok' }));
    const responses = [
      { content: '', toolCalls: [{ id: '1', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"rm -rf /"}' } }] },
      { content: '', toolCalls: [{ id: '2', type: 'function' as const, function: { name: 'run_command', arguments: '{"command":"npm test"}' } }] },
      { content: 'Terminado.', toolCalls: [] },
    ];
    let index = 0;
    const client = { chat: vi.fn().mockImplementation(async () => responses[Math.min(index++, 2)]) };

    const result = await runDeepSeekCodingTask(
      { runner, codespaceName: 'c', workdir: '/workspaces/agent-workspace/app', task: 't' },
      client as never,
    );

    expect(result.summary).toBe('Terminado.');
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toContain('npm test');
  });
});
