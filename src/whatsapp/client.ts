import { env } from '../config/env';
import type { WhatsAppClient } from './types';

const GRAPH_API_VERSION = 'v20.0';

export async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  if (!env.whatsappAccessToken || !env.whatsappPhoneNumberId) {
    throw new Error(
      'WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID son necesarios para enviar mensajes',
    );
  }

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${env.whatsappPhoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsappAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`WhatsApp Cloud API respondió con HTTP ${response.status}`);
  }
}

export const whatsappClient: WhatsAppClient = { sendWhatsAppMessage };