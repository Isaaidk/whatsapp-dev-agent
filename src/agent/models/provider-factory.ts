import { env } from '../../config/env';
import type { ModelProvider } from './provider';
import { GeminiProvider } from './providers/GeminiProvider';
import { DeepSeekProvider } from './providers/DeepSeekProvider';

export function createConfiguredModelProvider(): ModelProvider {
  switch (env.modelProvider) {
    case 'deepseek':
      return new DeepSeekProvider();
    case 'gemini':
      return new GeminiProvider();
    default:
      throw new Error(
        `MODEL_PROVIDER no soportado: ${env.modelProvider}. Proveedores disponibles: deepseek, gemini.`,
      );
  }
}

/**
 * Proveedor que atiende la conversación (tareas de `CONVERSATIONAL_TASKS`).
 * Devuelve `undefined` si no hay proveedor o falta su clave: en ese caso todo
 * pasa por el proveedor principal.
 */
export function createConversationalModelProvider(): ModelProvider | undefined {
  switch (env.conversationalProvider) {
    case 'gemini':
      return env.geminiApiKey ? new GeminiProvider() : undefined;
    case 'deepseek':
      return env.deepseekApiKey ? new DeepSeekProvider() : undefined;
    case 'none':
    case '':
      return undefined;
    default:
      console.warn(
        `CONVERSATIONAL_PROVIDER no soportado: ${env.conversationalProvider}. Se usará el proveedor principal.`,
      );
      return undefined;
  }
}