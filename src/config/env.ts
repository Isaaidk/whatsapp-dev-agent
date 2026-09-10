import dotenv from 'dotenv';
import { createPrivateKey } from 'node:crypto';

dotenv.config();

function readAuthorizedNumbers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((number) => number.trim())
      .filter(Boolean),
  );
}

function readAuthorizedIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

function readBoolean(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes((value ?? '').trim().toLowerCase());
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readTaskList(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function normalizeGithubPrivateKey(value: string | undefined): string {
  const key = value?.replace(/\\n/g, '\n').trim() ?? '';
  if (!key || key.includes('-----BEGIN')) return key;
  try {
    return createPrivateKey({
      key: Buffer.from(key, 'base64'),
      format: 'der',
      type: 'pkcs1',
    }).export({ format: 'pem', type: 'pkcs1' }).toString();
  } catch {
    return key;
  }
}

export const env = {
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '',
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '',
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL?.trim() ?? '',
  authorizedTelegramUserIds: readAuthorizedIds(process.env.AUTHORIZED_TELEGRAM_USER_IDS),
  modelProvider: process.env.MODEL_PROVIDER?.trim().toLowerCase() || 'gemini',
  /** Proveedor que atiende la conversación; el principal se reserva para planes y código. */
  conversationalProvider: process.env.CONVERSATIONAL_PROVIDER?.trim().toLowerCase() || 'gemini',
  conversationalTasks: readTaskList(process.env.CONVERSATIONAL_TASKS, ['GENERAL', 'ARCHITECTURE']),
  geminiApiKey: process.env.GEMINI_API_KEY?.trim() ?? '',
  geminiModel: process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-3.5-flash-lite',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL?.trim().replace(/\/+$/, '') || 'https://api.deepseek.com',
  deepseekModel: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
  deepseekTimeoutMs: readPositiveInteger(process.env.DEEPSEEK_TIMEOUT_MS, 120_000),
  deepseekAgentModel: process.env.DEEPSEEK_AGENT_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
  deepseekAgentMaxSteps: readPositiveInteger(process.env.DEEPSEEK_AGENT_MAX_STEPS, 12),
  agentMemoryFile: process.env.AGENT_MEMORY_FILE?.trim() || '.data/agent-contexts.json',
  agentPersonality: process.env.AGENT_PERSONALITY?.trim() || 'profesional, claro, proactivo y práctico',
  githubAppId: process.env.GITHUB_APP_ID?.trim() ?? '',
  githubAppPrivateKey: normalizeGithubPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY),
  githubInstallationId: process.env.GITHUB_INSTALLATION_ID?.trim() ?? '',
  githubToken: process.env.GITHUB_TOKEN?.trim() ?? '',
  githubCodespacesToken: process.env.GITHUB_CODESPACES_TOKEN?.trim() ?? '',
  githubCodespacesMachine: process.env.GITHUB_CODESPACES_MACHINE?.trim() || 'standardLinux32gb',
  githubCodespacesWorkdir: process.env.GITHUB_CODESPACES_WORKDIR?.trim() || '/workspaces/agent-workspace',
  githubCodespacesName: process.env.GITHUB_CODESPACES_NAME?.trim() ?? '',
  codespaceAgentCommand: process.env.CODESPACE_AGENT_COMMAND?.trim() ?? '',
  codespacePlannerCommand: process.env.CODESPACE_PLANNER_COMMAND?.trim() ?? '',
  codespaceCopilotModel: process.env.CODESPACE_COPILOT_MODEL?.trim() || 'auto',
  codespaceCommandTimeoutMs: readPositiveInteger(process.env.CODESPACE_COMMAND_TIMEOUT_MS, 120_000),
  codespacePlanTimeoutMs: readPositiveInteger(process.env.CODESPACE_PLAN_TIMEOUT_MS, 240_000),
  codespaceImplementTimeoutMs: readPositiveInteger(process.env.CODESPACE_IMPLEMENT_TIMEOUT_MS, 900_000),
  codespaceReviewTimeoutMs: readPositiveInteger(process.env.CODESPACE_REVIEW_TIMEOUT_MS, 300_000),
  codespaceGitTimeoutMs: readPositiveInteger(process.env.CODESPACE_GIT_TIMEOUT_MS, 300_000),
  allowWriteOperations: readBoolean(process.env.ALLOW_WRITE_OPERATIONS),
  agentBranchPrefix: process.env.AGENT_BRANCH_PREFIX?.trim() || 'agent/',
  agentCommitName: process.env.AGENT_COMMIT_NAME?.trim() || 'AI Development Agent',
  agentCommitEmail: process.env.AGENT_COMMIT_EMAIL?.trim() || 'ai-agent@users.noreply.github.com',
  authorizedWhatsappNumbers: readAuthorizedNumbers(
    process.env.AUTHORIZED_WHATSAPP_NUMBERS,
  ),
};

export function isDeepSeekConfigured(): boolean {
  return Boolean(env.deepseekApiKey);
}

export function isGeminiConfigured(): boolean {
  return Boolean(env.geminiApiKey);
}

export function codespaceWorkdirFor(repositoryFullName?: string): string {
  const root = env.githubCodespacesWorkdir.replace(/\/+$/, '');
  if (!repositoryFullName) return root;
  const name = repositoryFullName.split('/').pop() ?? repositoryFullName;
  return `${root}/${name}`;
}

export function isAuthorizedWhatsappNumber(senderId: string): boolean {
  return (
    env.authorizedWhatsappNumbers.size === 0 ||
    env.authorizedWhatsappNumbers.has(senderId)
  );
}

export function isAuthorizedTelegramUser(userId: string): boolean {
  return (
    env.authorizedTelegramUserIds.size === 0 ||
    env.authorizedTelegramUserIds.has(userId)
  );
}