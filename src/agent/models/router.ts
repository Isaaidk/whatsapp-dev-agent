import type { ModelGenerationRequest, ModelProvider, ModelTaskType } from './provider';
import { env } from '../../config/env';

/**
 * Elige proveedor por tipo de tarea: uno conversacional (barato y rápido) para
 * hablar con el usuario y otro principal para planificar y escribir código.
 * Si el conversacional falla, cae al principal en vez de romper el chat.
 */
export class ModelRouter {
  constructor(
    private readonly provider: ModelProvider,
    private readonly conversational?: ModelProvider,
  ) {}

  async generate(request: {
    taskType: ModelTaskType;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> {
    if (this.conversational && env.conversationalTasks.includes(request.taskType)) {
      try {
        return await this.conversational.generate(request);
      } catch (error) {
        console.warn(
          `El proveedor conversacional (${env.conversationalProvider}) falló; uso el principal:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return this.provider.generate(request);
  }

  /** Indica qué proveedor atendería una tarea, para diagnósticos y pruebas. */
  providerNameFor(taskType: ModelTaskType): 'conversational' | 'principal' {
    return this.conversational && env.conversationalTasks.includes(taskType)
      ? 'conversational'
      : 'principal';
  }
}

export type { ModelGenerationRequest };