import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRouter } from '../src/agent/models/router';
import type { ModelProvider } from '../src/agent/models/provider';
import { env } from '../src/config/env';

const originalTasks = env.conversationalTasks;

afterEach(() => {
  env.conversationalTasks = originalTasks;
  vi.restoreAllMocks();
});

function fakeProvider(response: string): ModelProvider & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn().mockResolvedValue(response) } as never;
}

const request = (taskType: 'GENERAL' | 'PLANNING' | 'ARCHITECTURE' | 'CODING' | 'REVIEW') => ({
  taskType,
  systemPrompt: 's',
  userPrompt: 'u',
});

describe('ModelRouter: reparto por tipo de tarea', () => {
  it('manda la conversación al proveedor conversacional', async () => {
    env.conversationalTasks = ['GENERAL', 'ARCHITECTURE'];
    const principal = fakeProvider('desde el principal');
    const conversational = fakeProvider('desde el conversacional');
    const router = new ModelRouter(principal, conversational);

    await expect(router.generate(request('GENERAL'))).resolves.toBe('desde el conversacional');
    await expect(router.generate(request('ARCHITECTURE'))).resolves.toBe('desde el conversacional');
    expect(principal.generate).not.toHaveBeenCalled();
    expect(conversational.generate).toHaveBeenCalledTimes(2);
  });

  it('manda los planes y el código al proveedor principal', async () => {
    env.conversationalTasks = ['GENERAL', 'ARCHITECTURE'];
    const principal = fakeProvider('desde el principal');
    const conversational = fakeProvider('desde el conversacional');
    const router = new ModelRouter(principal, conversational);

    for (const taskType of ['PLANNING', 'CODING', 'REVIEW'] as const) {
      await expect(router.generate(request(taskType))).resolves.toBe('desde el principal');
    }
    expect(conversational.generate).not.toHaveBeenCalled();
    expect(principal.generate).toHaveBeenCalledTimes(3);
  });

  it('respeta una lista de tareas personalizada', async () => {
    env.conversationalTasks = ['GENERAL'];
    const principal = fakeProvider('principal');
    const conversational = fakeProvider('conversacional');
    const router = new ModelRouter(principal, conversational);

    await expect(router.generate(request('ARCHITECTURE'))).resolves.toBe('principal');
    await expect(router.generate(request('GENERAL'))).resolves.toBe('conversacional');
  });

  it('usa el principal para todo cuando no hay conversacional', async () => {
    env.conversationalTasks = ['GENERAL', 'ARCHITECTURE'];
    const principal = fakeProvider('principal');
    const router = new ModelRouter(principal);

    await expect(router.generate(request('GENERAL'))).resolves.toBe('principal');
    expect(router.providerNameFor('GENERAL')).toBe('principal');
  });

  it('cae al principal si el conversacional falla', async () => {
    env.conversationalTasks = ['GENERAL'];
    const principal = fakeProvider('salvado por el principal');
    const conversational: ModelProvider = {
      generate: vi.fn().mockRejectedValue(new Error('gemini caído')),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const router = new ModelRouter(principal, conversational);

    await expect(router.generate(request('GENERAL'))).resolves.toBe('salvado por el principal');
    expect(warn).toHaveBeenCalled();
    expect(principal.generate).toHaveBeenCalledOnce();
  });

  it('informa del proveedor asignado a cada tarea', () => {
    env.conversationalTasks = ['GENERAL'];
    const router = new ModelRouter(fakeProvider('a'), fakeProvider('b'));

    expect(router.providerNameFor('GENERAL')).toBe('conversational');
    expect(router.providerNameFor('CODING')).toBe('principal');
  });
});
