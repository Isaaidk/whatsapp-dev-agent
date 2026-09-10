import type { MessageIdStore, MessagingClient } from '../channels/types';

export interface TelegramClient extends MessagingClient {
  sendTelegramMessage(chatId: string, text: string): Promise<void>;
  sendTelegramDocument(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendTelegramPhoto(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendTelegramAudio(chatId: string, filePath: string, caption?: string): Promise<void>;
}

export type { MessageIdStore };