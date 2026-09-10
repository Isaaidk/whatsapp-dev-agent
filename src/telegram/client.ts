import { env } from '../config/env';
import type { TelegramClient } from './types';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { splitTelegramText } from './format';

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN es necesario para enviar mensajes');
  }

  const chunks = splitTelegramText(text);
  for (const chunk of chunks) {
    const response = await fetch(
      `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      },
    );

    if (!response.ok) {
      throw new Error(`Telegram Bot API respondió con HTTP ${response.status}`);
    }
  }
}

export async function registerTelegramWebhook(): Promise<void> {
  if (!env.telegramBotToken || !env.telegramWebhookUrl) return;

  const response = await fetch(
    `https://api.telegram.org/bot${env.telegramBotToken}/setWebhook`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: env.telegramWebhookUrl,
        ...(env.telegramWebhookSecret
          ? { secret_token: env.telegramWebhookSecret }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Telegram no pudo registrar el webhook: HTTP ${response.status}`);
  }
}

async function sendTelegramFile(
  method: 'sendDocument' | 'sendPhoto' | 'sendAudio',
  field: 'document' | 'photo' | 'audio',
  chatId: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  if (!env.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN es necesario para enviar archivos');
  const form = new FormData();
  form.set('chat_id', chatId);
  if (caption) form.set('caption', caption);
  form.set(field, new Blob([await readFile(filePath)]), basename(filePath));
  const response = await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/${method}`, {
    method: 'POST',
    body: form,
  });
  if (!response.ok) throw new Error(`Telegram Bot API respondió con HTTP ${response.status}`);
}

export const telegramClient: TelegramClient = {
  sendTelegramMessage,
  sendMessage: sendTelegramMessage,
  sendTelegramDocument: (chatId, filePath, caption) => sendTelegramFile('sendDocument', 'document', chatId, filePath, caption),
  sendTelegramPhoto: (chatId, filePath, caption) => sendTelegramFile('sendPhoto', 'photo', chatId, filePath, caption),
  sendTelegramAudio: (chatId, filePath, caption) => sendTelegramFile('sendAudio', 'audio', chatId, filePath, caption),
};