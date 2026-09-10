import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent/agent';
import { GeminiProvider } from '../src/agent/models/providers/GeminiProvider';
import { createConfiguredModelProvider } from '../src/agent/models/provider-factory';
import { ModelProviderError } from '../src/agent/models/provider';
import { ModelRouter } from '../src/agent/models/router';
import { DEVELOPMENT_AGENT_SYSTEM_PROMPT } from '../src/agent/prompts/system';
import { env } from '../src/config/env';

const incomingMessage = {
  userId: '34600000000',
  senderNumber: '34600000000',
  contactName: 'Ada',
  messageId: 'wamid.test',
  timestamp: '1730000000',
  text: 'Hola',
};

afterEach(() => {
  env.modelProvider = 'gemini';
});

describe('createConfiguredModelProvider', () => {
  it('crea el proveedor Gemini cuando está configurado', () => {
    env.modelProvider = 'gemini';

    expect(createConfiguredModelProvider()).toBeInstanceOf(GeminiProvider);
  });

  it('rechaza proveedores desconocidos', () => {
    env.modelProvider = 'unknown-provider';

    expect(() => createConfiguredModelProvider()).toThrow(
      'MODEL_PROVIDER no soportado: unknown-provider',
    );
  });
});

describe('ModelRouter', () => {
  it('delega la generación al provider configurado', async () => {
    const provider = { generate: vi.fn().mockResolvedValue('respuesta') };
    const router = new ModelRouter(provider);

    await expect(
      router.generate({ taskType: 'GENERAL', systemPrompt: 'system', userPrompt: 'user' }),
    ).resolves.toBe('respuesta');
    expect(provider.generate).toHaveBeenCalledWith({
      taskType: 'GENERAL',
      systemPrompt: 'system',
      userPrompt: 'user',
    });
  });
});

describe('GeminiProvider', () => {
  it('genera texto usando el cliente Gemini inyectado', async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: '  respuesta Gemini  ' });
    const provider = new GeminiProvider(
      'test-key',
      'gemini-test',
      1000,
      { models: { generateContent } },
    );

    await expect(
      provider.generate({ taskType: 'GENERAL', systemPrompt: 'system', userPrompt: 'user' }),
    ).resolves.toBe('respuesta Gemini');
    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-test',
        contents: 'user',
        config: expect.objectContaining({ systemInstruction: 'system' }),
      }),
    );
  });

  it('falla con error estructurado si falta la API key', async () => {
    const provider = new GeminiProvider('', 'gemini-test', 1000);

    await expect(
      provider.generate({ taskType: 'GENERAL', systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toMatchObject({
      name: 'ModelProviderError',
      code: 'CONFIGURATION_ERROR',
    });
  });

  it('convierte un timeout en error estructurado', async () => {
    const generateContent = vi.fn().mockImplementation(
      ({ config }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_, reject) => {
          config.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const provider = new GeminiProvider(
      'test-key',
      'gemini-test',
      1,
      { models: { generateContent } },
    );

    await expect(
      provider.generate({ taskType: 'GENERAL', systemPrompt: 'system', userPrompt: 'user' }),
    ).rejects.toMatchObject({
      name: 'ModelProviderError',
      code: 'TIMEOUT',
    });
  });

  it('convierte errores del proveedor en error estructurado sin exponer secretos', async () => {
    const generateContent = vi.fn().mockRejectedValue(new Error('upstream failure test-key'));
    const provider = new GeminiProvider(
      'test-key',
      'gemini-test',
      1000,
      { models: { generateContent } },
    );

    let caughtError: unknown;
    try {
      await provider.generate({ taskType: 'GENERAL', systemPrompt: 'system', userPrompt: 'user' });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(ModelProviderError);
    expect((caughtError as Error).message).not.toContain('test-key');
  });
});

describe('Agent', () => {
  it('consulta ModelRouter y devuelve la respuesta para WhatsApp', async () => {
    const generate = vi.fn().mockResolvedValue('Hola desde el modelo');
    const agent = new Agent(
      new ModelRouter({ generate }),
      undefined,
      new Map(),
      { load: () => new Map(), save: vi.fn() },
    );

    await expect(agent.handleMessage(incomingMessage)).resolves.toBe('Hola desde el modelo');
    expect(generate).toHaveBeenCalledWith({
      taskType: 'GENERAL',
      systemPrompt: `${DEVELOPMENT_AGENT_SYSTEM_PROMPT}\nPersonalidad: profesional, claro, proactivo y práctico`,
      userPrompt: 'Hola',
    });
  });
});