export interface IncomingMessage {
  channel: 'telegram' | 'whatsapp';
  userId: string;
  senderId?: string;
  contactName?: string;
  messageId: string;
  timestamp: string;
  text: string;
  chatId?: string;
}

export interface MessagingClient {
  sendMessage(to: string, text: string): Promise<void>;
}

export interface MessageIdStore {
  has(messageId: string): boolean;
  add(messageId: string): void;
}

export class MemoryMessageIdStore implements MessageIdStore {
  private readonly messageIds = new Set<string>();

  has(messageId: string): boolean {
    return this.messageIds.has(messageId);
  }

  add(messageId: string): void {
    this.messageIds.add(messageId);
  }
}