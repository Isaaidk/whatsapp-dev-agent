import type { IncomingMessage } from '../channels/types';
import { createAgentContext, FileAgentContextStore, trimAgentContext, type AgentContext, type AgentContextStore } from './context';
import { ModelRouter } from './models/router';
import { DEVELOPMENT_AGENT_SYSTEM_PROMPT } from './prompts/system';
import { Orchestrator } from './orchestrator';
import { env } from '../config/env';

export class Agent {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly orchestrator = new Orchestrator(undefined, modelRouter),
    private readonly contexts = new FileAgentContextStore(env.agentMemoryFile).load(),
    private readonly contextStore: AgentContextStore = new FileAgentContextStore(env.agentMemoryFile),
  ) {}

  async handleMessage(message: IncomingMessage): Promise<string> {
    const context = this.contexts.get(message.userId) ?? createAgentContext();
    context.user = {
      id: message.userId,
      phoneNumber: message.senderId,
      name: message.contactName,
    };
    context.history.push({ role: 'user', content: message.text });

    const orchestratedResponse = await this.orchestrator.handleMessage(message, context);
    if (orchestratedResponse !== undefined) {
      context.history.push({ role: 'assistant', content: orchestratedResponse });
      this.persist(message.userId, context);
      return orchestratedResponse;
    }

    const response = await this.modelRouter.generate({
      taskType: 'GENERAL',
      systemPrompt: `${DEVELOPMENT_AGENT_SYSTEM_PROMPT}\nPersonalidad: ${env.agentPersonality}`,
      userPrompt: this.buildPrompt(message.text, context),
    });

    context.history.push({ role: 'assistant', content: response });
    this.persist(message.userId, context);
    return response;
  }

  private buildPrompt(messageText: string, context: AgentContext): string {
    const recentHistory = context.history.slice(-10);
    if (!context.currentRepository && recentHistory.length <= 1) return messageText;
    return [
      'Contexto persistente de la conversación:',
      `Repositorio seleccionado: ${context.currentRepository ?? 'ninguno'}`,
      `Branch: ${context.selectedBranch ?? 'ninguna'}`,
      `Historial reciente: ${JSON.stringify(recentHistory)}`,
      '',
      `Solicitud actual: ${messageText}`,
    ].join('\n');
  }

  private persist(userId: string, context: AgentContext): void {
    this.contexts.set(userId, trimAgentContext(context));
    this.contextStore.save(this.contexts);
  }

  /** Persiste un contexto que pudo haber cambiado en segundo plano. */
  persistContext(context: AgentContext): void {
    const userId = context.user?.id;
    if (!userId) return;
    this.persist(userId, context);
  }
}