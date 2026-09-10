export interface AgentJob {
  id: string;
  chatId: string;
  description: string;
  startedAt: number;
}

export interface JobContext extends AgentJob {
  /** Envía un mensaje de progreso al usuario sin lanzar excepciones. */
  notify(text: string): Promise<void>;
  /** Adjunta un archivo local al chat, si el canal lo permite. */
  attachFile?(filePath: string, caption?: string): Promise<void>;
}

export interface JobNotifier {
  notify(chatId: string, text: string): Promise<void>;
  sendFile?(chatId: string, filePath: string, caption?: string): Promise<void>;
}

/**
 * Registro en memoria de trabajos largos (análisis, implementación, push).
 * Permite varias tareas simultáneas en chats distintos y evita que un mismo
 * chat lance dos operaciones a la vez.
 */
export class AgentJobRegistry {
  private readonly active = new Map<string, AgentJob>();
  private notifier: JobNotifier | undefined;

  constructor(notifier?: JobNotifier) {
    this.notifier = notifier;
  }

  setNotifier(notifier: JobNotifier): void {
    this.notifier = notifier;
  }

  current(chatId: string): AgentJob | undefined {
    return this.active.get(chatId);
  }

  isBusy(chatId: string): boolean {
    return this.active.has(chatId);
  }

  /** Reserva el chat para una tarea. Devuelve `undefined` si ya hay una en curso. */
  begin(chatId: string, description: string): JobContext | undefined {
    if (!chatId || this.active.has(chatId)) return undefined;
    const job: AgentJob = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      description,
      startedAt: Date.now(),
    };
    this.active.set(chatId, job);
    return {
      ...job,
      notify: (text: string) => this.notify(chatId, text),
      ...(this.notifier?.sendFile
        ? { attachFile: (filePath: string, caption?: string) => this.sendFile(chatId, filePath, caption) }
        : {}),
    };
  }

  finish(chatId: string): void {
    this.active.delete(chatId);
  }

  async notify(chatId: string, text: string): Promise<void> {
    if (!this.notifier || !chatId || !text.trim()) return;
    try {
      await this.notifier.notify(chatId, text);
    } catch (error) {
      console.error(
        'No pude enviar la notificación de progreso:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.notifier?.sendFile || !chatId || !filePath) return;
    try {
      await this.notifier.sendFile(chatId, filePath, caption);
    } catch (error) {
      console.error(
        'No pude enviar el archivo adjunto:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'error desconocido';
}
