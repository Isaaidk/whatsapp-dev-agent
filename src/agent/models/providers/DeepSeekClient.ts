import { env } from '../../../config/env';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface DeepSeekChatOptions {
  model?: string;
  tools?: DeepSeekTool[];
  temperature?: number;
  timeoutMs?: number;
}

export interface DeepSeekChatResult {
  content: string;
  toolCalls: DeepSeekToolCall[];
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly code: 'CONFIGURATION_ERROR' | 'TIMEOUT' | 'UPSTREAM_ERROR' | 'EMPTY_RESPONSE',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: DeepSeekToolCall[];
    };
  }>;
  error?: { message?: string };
}

/** Cliente mínimo de la API de DeepSeek, compatible con el formato de OpenAI. */
export class DeepSeekClient {
  constructor(
    private readonly apiKey: string = env.deepseekApiKey,
    private readonly baseUrl: string = env.deepseekBaseUrl,
    private readonly timeoutMs: number = env.deepseekTimeoutMs,
  ) {}

  async chat(messages: DeepSeekMessage[], options: DeepSeekChatOptions = {}): Promise<DeepSeekChatResult> {
    if (!this.apiKey) {
      throw new DeepSeekError(
        'Falta DEEPSEEK_API_KEY. Añádela al entorno para usar el modelo de DeepSeek.',
        'CONFIGURATION_ERROR',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model ?? env.deepseekModel,
          messages,
          temperature: options.temperature ?? 0.2,
          ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
        }),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new DeepSeekError(
          `DeepSeek respondió con HTTP ${response.status}: ${sanitize(raw, this.apiKey).slice(0, 240)}`,
          response.status === 429 || response.status >= 500 ? 'UPSTREAM_ERROR' : 'CONFIGURATION_ERROR',
          response.status,
        );
      }

      let payload: ChatCompletionPayload;
      try {
        payload = JSON.parse(raw) as ChatCompletionPayload;
      } catch {
        throw new DeepSeekError('DeepSeek devolvió una respuesta que no pude interpretar.', 'UPSTREAM_ERROR');
      }

      const message = payload.choices?.[0]?.message;
      const content = typeof message?.content === 'string' ? message.content : '';
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      if (!content.trim() && toolCalls.length === 0) {
        throw new DeepSeekError('DeepSeek no devolvió contenido en la respuesta.', 'EMPTY_RESPONSE');
      }
      return { content, toolCalls };
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DeepSeekError(
          `DeepSeek no respondió en ${Math.round((options.timeoutMs ?? this.timeoutMs) / 1000)}s.`,
          'TIMEOUT',
        );
      }
      throw new DeepSeekError(
        `No pude contactar con DeepSeek: ${sanitize(error instanceof Error ? error.message : String(error), this.apiKey).slice(0, 240)}`,
        'UPSTREAM_ERROR',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sanitize(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join('[clave oculta]') : text;
  return withoutKey.replace(/\s+/g, ' ').trim();
}
