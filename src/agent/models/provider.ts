export type ModelTaskType =
  | 'GENERAL'
  | 'PLANNING'
  | 'ARCHITECTURE'
  | 'CODING'
  | 'REVIEW';

export interface ModelGenerationRequest {
  taskType: ModelTaskType;
  systemPrompt: string;
  userPrompt: string;
}

export interface ModelProvider {
  generate(request: ModelGenerationRequest): Promise<string>;
}

export type ModelProviderErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'EMPTY_RESPONSE';

export class ModelProviderError extends Error {
  constructor(
    public readonly code: ModelProviderErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelProviderError';
  }
}