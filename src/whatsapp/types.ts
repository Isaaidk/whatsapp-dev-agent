import type { IncomingMessage, MessageIdStore } from '../channels/types';
export { MemoryMessageIdStore } from '../channels/types';

export type IncomingTextMessage = IncomingMessage & {
  channel: 'whatsapp';
  senderNumber?: string;
  phoneNumberId?: string;
};

export interface WhatsAppClient {
  sendWhatsAppMessage(to: string, text: string): Promise<void>;
}

export type { MessageIdStore };
