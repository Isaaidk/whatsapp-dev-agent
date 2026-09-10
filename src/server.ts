import express, { type Express } from 'express';
import { env } from './config/env';
import { Agent } from './agent/agent';
import { Orchestrator } from './agent/orchestrator';
import { createConfiguredModelProvider, createConversationalModelProvider } from './agent/models/provider-factory';
import { ModelRouter } from './agent/models/router';
import { RepositoryManager } from './github/repository-manager';
import { OctokitGitHubClient } from './github/client';
import { whatsappClient } from './whatsapp/client';
import {
  receiveWebhookMessage,
  verifyWebhook,
} from './whatsapp/webhook';
import { MemoryMessageIdStore } from './whatsapp/types';
import type { MessageIdStore, WhatsAppClient } from './whatsapp/types';
import type { GitHubClient } from './github/types';
import { registerTelegramWebhook, telegramClient } from './telegram/client';
import { receiveTelegramWebhookMessage } from './telegram/webhook';
import type { TelegramClient } from './telegram/types';
import { GitHubCodespacesProvider } from './workspace/github-codespaces';
import type { WorkspaceProvider } from './workspace/types';
import { GhCliWorkspaceRunner } from './workspace/gh-cli-runner';
import type { WorkspaceRunner } from './workspace/runner';
import { formatTelegramText } from './telegram/format';
import { AgentJobRegistry } from './agent/jobs';

export interface AppOptions {
  messageIdStore?: MessageIdStore;
  whatsappClient?: WhatsAppClient;
  modelRouter?: ModelRouter;
  githubClient?: GitHubClient;
  repositoryManager?: RepositoryManager;
  telegramClient?: TelegramClient;
  workspaceProvider?: WorkspaceProvider;
  workspaceRunner?: WorkspaceRunner;
  jobs?: AgentJobRegistry;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const messageIdStore = options.messageIdStore ?? new MemoryMessageIdStore();
  const client = options.whatsappClient ?? whatsappClient;
  const telegram = options.telegramClient ?? telegramClient;
  const modelRouter = options.modelRouter ?? createConfiguredModelRouter();
  const githubClient = options.githubClient ?? createConfiguredGitHubClient();
  const repositoryManager = options.repositoryManager ?? new RepositoryManager(githubClient);
  const workspaceProvider = options.workspaceProvider ?? createWorkspaceProvider();
  const workspaceRunner = options.workspaceRunner ?? createWorkspaceRunner();
  const jobs = options.jobs ?? new AgentJobRegistry({
    notify: (chatId, text) => telegram.sendTelegramMessage(chatId, formatTelegramText(text)),
    sendFile: (chatId, filePath, caption) => telegram.sendTelegramDocument(chatId, filePath, caption),
  });
  const orchestrator = new Orchestrator(
    repositoryManager,
    modelRouter,
    workspaceProvider,
    workspaceRunner,
    jobs,
  );
  const agent = new Agent(modelRouter, orchestrator);
  orchestrator.setContextPersister((context) => agent.persistContext(context));

  app.use(express.json({ limit: '1mb' }));
  app.get('/', (_request, response) => response.send('Telegram Dev Agent funcionando'));
  app.get('/health', (_request, response) =>
    response.json({ status: 'ok', service: 'telegram-dev-agent' }),
  );
  app.get('/webhook', verifyWebhook);
  app.post('/telegram/webhook', (request, response) =>
    receiveTelegramWebhookMessage(
      request,
      response,
      messageIdStore,
      telegram,
      async (message) => {
        const generatedResponse = await agent.handleMessage(message);
        await telegram.sendTelegramMessage(message.chatId!, formatTelegramText(generatedResponse));
      },
    ),
  );
  app.post('/webhook', (request, response) =>
    receiveWebhookMessage(
      request,
      response,
      messageIdStore,
      client,
      async (message) => {
        const generatedResponse = await agent.handleMessage(message);
        await client.sendWhatsAppMessage(message.userId, generatedResponse);
      },
    ),
  );

  return app;
}

function createConfiguredModelRouter(): ModelRouter {
  return new ModelRouter(createConfiguredModelProvider(), createConversationalModelProvider());
}

function createConfiguredGitHubClient(): GitHubClient | undefined {
  if (
    !env.githubToken &&
    (!env.githubAppId || !env.githubAppPrivateKey || !env.githubInstallationId)
  ) return undefined;
  return new OctokitGitHubClient();
}

function createWorkspaceProvider(): WorkspaceProvider | undefined {
  if (!env.githubCodespacesToken) return undefined;
  try {
    return new GitHubCodespacesProvider();
  } catch {
    return undefined;
  }
}

function createWorkspaceRunner(): WorkspaceRunner | undefined {
  if (!env.githubCodespacesName) return undefined;
  return new GhCliWorkspaceRunner();
}

if (require.main === module) {
  const app = createApp();
  app.listen(env.port, '0.0.0.0', () => {
    console.log(`Telegram Dev Agent escuchando en 0.0.0.0:${env.port}`);
    if (env.modelProvider === 'deepseek' && !env.deepseekApiKey) {
      console.warn('MODEL_PROVIDER=deepseek pero falta DEEPSEEK_API_KEY: el agente no podrá conversar ni implementar.');
    }
    if (env.modelProvider === 'gemini' && !env.geminiApiKey) {
      console.warn('MODEL_PROVIDER=gemini pero falta GEMINI_API_KEY.');
    }
    if (!env.telegramBotToken) {
      console.warn('TELEGRAM_BOT_TOKEN no está configurado; añade el token de BotFather.');
      return;
    }
    registerTelegramWebhook()
      .then(() => console.log('Webhook de Telegram registrado correctamente.'))
      .catch((error) => console.error('No se pudo registrar el webhook de Telegram:', error));
  });
}