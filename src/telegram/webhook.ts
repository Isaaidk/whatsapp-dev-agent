import type { Request, Response } from 'express';
import { env, isAuthorizedTelegramUser } from '../config/env';
import type { IncomingMessage, MessageIdStore } from '../channels/types';
import type { TelegramClient } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractTelegramTextMessage(payload: unknown): IncomingMessage | null {
  if (!isRecord(payload) || !isRecord(payload.message)) return null;
  const message = payload.message;
  const chat = isRecord(message.chat) ? message.chat : undefined;
  const from = isRecord(message.from) ? message.from : undefined;

  if (
    typeof message.message_id !== 'number' ||
    typeof message.date !== 'number' ||
    typeof message.text !== 'string' ||
    !chat ||
    (typeof chat.id !== 'number' && typeof chat.id !== 'string')
  ) return null;

  const userId = from && (typeof from.id === 'number' || typeof from.id === 'string')
    ? String(from.id)
    : String(chat.id);

  return {
    channel: 'telegram',
    userId,
    senderId: userId,
    contactName: from && typeof from.first_name === 'string' ? from.first_name : undefined,
    messageId: String(message.message_id),
    timestamp: String(message.date),
    text: message.text,
    chatId: String(chat.id),
  };
}

export async function receiveTelegramWebhookMessage(
  request: Request,
  response: Response,
  messageIdStore: MessageIdStore,
  telegramClient: TelegramClient,
  onMessage: (message: IncomingMessage) => Promise<void>,
): Promise<void> {
  if (env.telegramWebhookSecret && request.header('x-telegram-bot-api-secret-token') !== env.telegramWebhookSecret) {
    response.sendStatus(403);
    return;
  }

  const message = extractTelegramTextMessage(request.body);
  if (!message || !message.chatId) {
    response.status(400).json({ error: 'Payload de Telegram no válido o sin mensaje de texto' });
    return;
  }
  if (messageIdStore.has(message.messageId)) {
    response.sendStatus(200);
    return;
  }
  messageIdStore.add(message.messageId);
  if (!isAuthorizedTelegramUser(message.userId)) {
    response.sendStatus(200);
    return;
  }

  try {
    await onMessage(message);
    response.sendStatus(200);
  } catch (error) {
    console.error('Error procesando mensaje de Telegram:', error instanceof Error ? error.message : error);
    try {
      await telegramClient.sendTelegramMessage(
        message.chatId,
        `No pude completar la operación: ${error instanceof Error ? error.message : 'error desconocido'}`,
      );
    } catch {
      // Si tampoco podemos avisar, no hay nada más que hacer aquí.
    }
    response.sendStatus(200);
  }
}