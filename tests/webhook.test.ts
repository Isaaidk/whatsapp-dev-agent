import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { createApp } from '../src/server';
import { extractTextMessage } from '../src/whatsapp/webhook';
import { MemoryMessageIdStore } from '../src/whatsapp/types';
import { ModelRouter } from '../src/agent/models/router';
import { extractTelegramTextMessage } from '../src/telegram/webhook';

const validPayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: 'phone-number-id' },
            contacts: [{ wa_id: '34600000000', profile: { name: 'Ada' } }],
            messages: [
              {
                from: '34600000000',
                id: 'wamid.message-1',
                timestamp: '1730000000',
                type: 'text',
                text: { body: 'Hola' },
              },
            ],
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  env.authorizedWhatsappNumbers = new Set();
});

describe('HTTP endpoints', () => {
  it('GET / responde con el estado del agente', async () => {
    const response = await request(createApp()).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Telegram Dev Agent funcionando');
  });

  it('GET /health devuelve JSON', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', service: 'telegram-dev-agent' });
  });

  it('GET /webhook devuelve el challenge con token correcto', async () => {
    env.whatsappVerifyToken = 'test-verify-token';
    const response = await request(createApp()).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'test-verify-token',
      'hub.challenge': 'challenge-value',
    });

    expect(response.status).toBe(200);
    expect(response.text).toBe('challenge-value');
  });

  it('GET /webhook rechaza un token incorrecto', async () => {
    env.whatsappVerifyToken = 'test-verify-token';
    const response = await request(createApp()).get('/webhook').query({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-value',
    });

    expect(response.status).toBe(403);
  });

  it('POST /webhook procesa un mensaje válido y usa el cliente mock', async () => {
    const sendWhatsAppMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue('Respuesta generada por Gemini');
    const response = await request(
      createApp({
        whatsappClient: { sendWhatsAppMessage },
        modelRouter: new ModelRouter({ generate }),
      }),
    )
      .post('/webhook')
      .send(validPayload);

    expect(response.status).toBe(200);
    expect(generate).toHaveBeenCalledOnce();
    expect(sendWhatsAppMessage).toHaveBeenCalledWith('34600000000', 'Respuesta generada por Gemini');
  });

  it('POST /webhook rechaza un payload inválido', async () => {
    const response = await request(createApp()).post('/webhook').send({ invalid: true });

    expect(response.status).toBe(400);
  });

  it('no procesa dos veces el mismo message ID', async () => {
    const sendWhatsAppMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue('Respuesta');
    const app = createApp({
      messageIdStore: new MemoryMessageIdStore(),
      whatsappClient: { sendWhatsAppMessage },
      modelRouter: new ModelRouter({ generate }),
    });
    const response = await request(app)
      .post('/webhook')
      .send(validPayload);
    const duplicateResponse = await request(app)
      .post('/webhook')
      .send(validPayload);

    expect(response.status).toBe(200);
    expect(duplicateResponse.status).toBe(200);
    expect(sendWhatsAppMessage).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('extractTextMessage', () => {
  it('extrae los datos principales de un mensaje de texto', () => {
    expect(extractTextMessage(validPayload)).toEqual({
      channel: 'whatsapp',
      userId: '34600000000',
      senderNumber: '34600000000',
      contactName: 'Ada',
      messageId: 'wamid.message-1',
      timestamp: '1730000000',
      text: 'Hola',
      phoneNumberId: 'phone-number-id',
    });
  });
});

describe('Telegram webhook', () => {
  const telegramPayload = {
    update_id: 1001,
    message: {
      message_id: 42,
      date: 1730000000,
      text: 'Hola desde Telegram',
      from: { id: 12345, first_name: 'Ada' },
      chat: { id: 12345, type: 'private' },
    },
  };

  beforeEach(() => {
    env.authorizedTelegramUserIds = new Set();
    env.telegramWebhookSecret = '';
  });

  it('extrae mensajes de texto de Telegram', () => {
    expect(extractTelegramTextMessage(telegramPayload)).toEqual({
      channel: 'telegram',
      userId: '12345',
      senderId: '12345',
      contactName: 'Ada',
      messageId: '42',
      timestamp: '1730000000',
      text: 'Hola desde Telegram',
      chatId: '12345',
    });
  });

  it('procesa Telegram y responde usando el cliente configurado', async () => {
    const sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue('Respuesta desde Telegram');
    const response = await request(createApp({
      telegramClient: {
        sendTelegramMessage,
        sendMessage: sendTelegramMessage,
      },
      modelRouter: new ModelRouter({ generate }),
    }))
      .post('/telegram/webhook')
      .send(telegramPayload);

    expect(response.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledWith('12345', 'Respuesta desde Telegram');
  });

  it('responde /start sin necesitar Gemini', async () => {
    const sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn();
    const response = await request(createApp({
      telegramClient: {
        sendTelegramMessage,
        sendMessage: sendTelegramMessage,
      },
      modelRouter: new ModelRouter({ generate }),
    }))
      .post('/telegram/webhook')
      .send({
        ...telegramPayload,
        message: { ...telegramPayload.message, message_id: 43, text: '/start' },
      });

    expect(response.status).toBe(200);
    expect(generate).not.toHaveBeenCalled();
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      '12345',
      'Hola. Soy tu asistente de desarrollo. Usa /habilidades para ver lo que puedo hacer, /repos para listar tus repositorios y /repo <nombre> para seleccionar uno.',
    );
  });

  it('lista repositorios de GitHub mediante Telegram', async () => {
    const sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn();
    const response = await request(createApp({
      telegramClient: {
        sendTelegramMessage,
        sendMessage: sendTelegramMessage,
      },
      modelRouter: new ModelRouter({ generate }),
      repositoryManager: {
        listRepositories: vi.fn().mockResolvedValue([
          {
            id: 1,
            name: 'whatsapp-dev-agent',
            fullName: 'isaac/whatsapp-dev-agent',
            owner: 'isaac',
            defaultBranch: 'main',
            private: true,
            language: 'TypeScript',
          },
        ]),
      } as never,
    }))
      .post('/telegram/webhook')
      .send({
        ...telegramPayload,
        message: { ...telegramPayload.message, message_id: 44, text: '/repos' },
      });

    expect(response.status).toBe(200);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      '12345',
      'Estos son tus repositorios disponibles:\n\n1. whatsapp-dev-agent',
    );
  });

  it('responde habilidades sin consultar Gemini', async () => {
    const sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn();
    const response = await request(createApp({
      telegramClient: { sendTelegramMessage, sendMessage: sendTelegramMessage },
      modelRouter: new ModelRouter({ generate }),
    }))
      .post('/telegram/webhook')
      .send({
        ...telegramPayload,
        message: { ...telegramPayload.message, message_id: 45, text: '/habilidades' },
      });

    expect(response.status).toBe(200);
    expect(generate).not.toHaveBeenCalled();
    expect(sendTelegramMessage.mock.calls[0][1]).toContain('Habilidades actuales:');
  });
});