import { env } from '../../../config/env';
import { ModelProviderError, type ModelGenerationRequest, type ModelProvider } from '../provider';
import { DeepSeekClient, DeepSeekError } from './DeepSeekClient';

/** Proveedor de modelos basado en la API oficial de DeepSeek. */
export class DeepSeekProvider implements ModelProvider {
  constructor(
    private readonly client = new DeepSeekClient(),
    private readonly model = env.deepseekModel,
    private readonly timeoutMs = env.deepseekTimeoutMs,
  ) {}

  async generate(request: ModelGenerationRequest): Promise<string> {
    try {
      const result = await this.client.chat(
        [
          { role: 'system', content: request.systemPrompt },
          { role: 'user', content: request.userPrompt },
        ],
        { model: this.model, timeoutMs: this.timeoutMs },
      );
      return result.content.trim();
    } catch (error) {
      if (error instanceof DeepSeekError) {
        throw new ModelProviderError(error.code, error.message, { cause: error });
      }
      throw new ModelProviderError(
        'UPSTREAM_ERROR',
        'No pude obtener respuesta de DeepSeek.',
        { cause: error },
      );
    }
  }
}
