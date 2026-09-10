import type { Request, Response } from 'express';
import type { IncomingTextMessage, MessageIdStore, WhatsAppClient } from './types';
import { env, isAuthorizedWhatsappNumber } from '../config/env';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractTextMessage(payload: unknown): IncomingTextMessage | null {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return null;

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      const value = change.value;
      if (!Array.isArray(value.messages)) continue;
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];

      for (const rawMessage of value.messages) {
        if (!isRecord(rawMessage) || rawMessage.type !== 'text') continue;
        if (
          typeof rawMessage.id !== 'string' ||
          typeof rawMessage.from !== 'string' ||
          typeof rawMessage.timestamp !== 'string' ||
          !isRecord(rawMessage.text) ||
          typeof rawMessage.text.body !== 'string'
        ) {
          continue;
        }

        const contact = contacts.find(
          (candidate) => isRecord(candidate) && candidate.wa_id === rawMessage.from,
        );
        const profile = isRecord(contact) && isRecord(contact.profile) ? contact.profile : undefined;

        return {
          channel: 'whatsapp',
          userId: rawMessage.from,
          senderNumber: rawMessage.from,
          contactName: profile && typeof profile.name === 'string' ? profile.name : undefined,
          messageId: rawMessage.id,
          timestamp: rawMessage.timestamp,
          text: rawMessage.text.body,
          phoneNumberId:
            isRecord(value.metadata) && typeof value.metadata.phone_number_id === 'string'
              ? value.metadata.phone_number_id
              : undefined,
        };
      }
    }
  }

  return null;
}

export function verifyWebhook(request: Request, response: Response): void {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === env.whatsappVerifyToken &&
    typeof challenge === 'string'
  ) {
    response.status(200).send(challenge);
    return;
  }

  response.sendStatus(403);
}

export function logIncomingMessage(message: IncomingTextMessage): void {
  console.log('# ====================================');
  console.log('WHATSAPP MESSAGE');
  console.log(`# From: ${message.senderNumber ?? message.userId}`);
  console.log(`Message ID: ${message.messageId}`);
  console.log(`Text: ${message.text}`);
  console.log(`Timestamp: ${message.timestamp}`);
}

export async function receiveWebhookMessage(
  request: Request,
  response: Response,
  messageIdStore: MessageIdStore,
  whatsappClient: WhatsAppClient,
  onMessage: (message: IncomingTextMessage) => Promise<void>,
): Promise<void> {
  const message = extractTextMessage(request.body);
  if (!message) {
    response.status(400).json({ error: 'Payload de WhatsApp no válido o sin mensaje de texto' });
    return;
  }

  if (messageIdStore.has(message.messageId)) {
    response.sendStatus(200);
    return;
  }
  messageIdStore.add(message.messageId);
  logIncomingMessage(message);

  if (!isAuthorizedWhatsappNumber(message.userId)) {
    response.sendStatus(200);
    return;
  }

  try {
    await onMessage(message);
    response.sendStatus(200);
  } catch (error) {
    console.error('Error procesando mensaje de WhatsApp:', error instanceof Error ? error.message : error);
    response.sendStatus(500);
  }
}