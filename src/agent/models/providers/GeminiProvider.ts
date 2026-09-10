import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { env } from '../../../config/env';
import {
  ModelProviderError,
  type ModelGenerationRequest,
  type ModelProvider,
} from '../provider';

interface GeminiModelClient {
  models: {
    generateContent(
      parameters: GenerateContentParameters,
    ): Promise<{ text?: string }>;
  };
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class GeminiProvider implements ModelProvider {
  private readonly client?: GeminiModelClient;

  constructor(
    private readonly apiKey = env.geminiApiKey,
    private readonly model = env.geminiModel,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    client?: GeminiModelClient,
  ) {
    this.client = client ?? (apiKey ? new GoogleGenAI({ apiKey }) : undefined);
  }

  async generate(request: ModelGenerationRequest): Promise<string> {
    if (!this.apiKey || !this.client) {
      throw new ModelProviderError(
        'CONFIGURATION_ERROR',
        'GEMINI_API_KEY no está configurada; no se puede generar una respuesta.',
      );
    }

    const models = [this.model];
    if (env.geminiFallbackModel !== this.model) models.push(env.geminiFallbackModel);
    let lastError: unknown;

    for (const model of models) {
      try {
        return await this.generateWithModel(request, model);
      } catch (error) {
        lastError = error;
        if (!isTemporaryCapacityError(error) || model === models[models.length - 1]) throw error;
      }
    }

    throw lastError;
  }

  private async generateWithModel(request: ModelGenerationRequest, model: string): Promise<string> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);
    try {
      const response = await this.client!.models.generateContent({
        model,
        contents: request.userPrompt,
        config: {
          systemInstruction: request.systemPrompt,
          abortSignal: abortController.signal,
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      });
      const text = response.text?.trim();
      if (!text) throw new ModelProviderError('EMPTY_RESPONSE', 'Gemini no devolvió texto en la respuesta.');
      return text;
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (abortController.signal.aborted) {
        throw new ModelProviderError('TIMEOUT', `Gemini no respondió dentro de ${this.timeoutMs} ms.`, { cause: error });
      }
      throw new ModelProviderError(
        'UPSTREAM_ERROR',
        `Gemini no pudo generar la respuesta${error instanceof Error && error.message ? `: ${sanitizeErrorMessage(error.message, this.apiKey)}` : '.'}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isTemporaryCapacityError(error: unknown): boolean {
  return error instanceof ModelProviderError && /\b(404|429|500|503)\b|no longer available|high demand|overloaded|unavailable/i.test(error.message);
}

function sanitizeErrorMessage(message: string, apiKey: string): string {
  return message
    .replaceAll(apiKey, '[redacted-key]')
    .replace(/AIza[\w-]+/g, '[redacted-key]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}