// Smoke-тесты бот-хендлеров: проверяем allowlist и роутинг через
// прокачку сырых update'ов в grammY. Не запускаем сеть: bot.api перехвачен.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Bot } from 'grammy';
import { registerHandlers } from '../src/bot/handlers.js';

// Глушим очереди — для unit-тестов BullMQ не нужен.
vi.mock('../src/jobs/queues.js', () => ({
  audioQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'jobA' }) }),
  referenceDlQueue: () => ({ add: vi.fn().mockResolvedValue({ id: 'jobR' }) }),
}));

interface MockSendMessage {
  chat_id: number | string;
  text: string;
}

function buildBot(allowedUserId: number): { bot: Bot; sent: MockSendMessage[] } {
  const bot = new Bot('1234:test-token', {
    // botInfo передаём через any: тип UserFromGetMe в grammY 1.42 шире нашей
    // потребности (нужны лишь несколько полей для маршрутизации).
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as any,
  });
  const sent: MockSendMessage[] = [];
  // Перехватываем все api-вызовы.
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') {
      sent.push(payload as MockSendMessage);
      return { ok: true, result: { message_id: 1, chat: { id: 0, type: 'private' }, date: 0 } } as any;
    }
    if (method === 'getMe') return bot.botInfo as any;
    return { ok: true, result: {} } as any;
  });
  registerHandlers(bot, { allowedUserId });
  return { bot, sent };
}

function mkUpdate(overrides: Record<string, unknown>): any {
  return {
    update_id: 1,
    message: {
      message_id: 42,
      date: 1736512000,
      chat: { id: 100, type: 'private' },
      from: { id: 100, is_bot: false, first_name: 'YE' },
      ...overrides,
    },
  };
}

describe('bot handlers — allowlist', () => {
  beforeEach(() => vi.clearAllMocks());

  it('текст от не-Юрия → игнорируется', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({
      text: 'привет',
      from: { id: 999, is_bot: false, first_name: 'Hacker' },
    }));
    expect(sent.length).toBe(0);
  });

  it('голос от Юрия → enqueue + ответ "Принял голосовое"', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({
      voice: { file_id: 'voice_file_123', file_unique_id: 'u1', duration: 12 },
    }));
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain('Принял голосовое');
  });

  it('форвард с IG URL → enqueue реф + ответ "Принял референс"', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({
      text: 'смотри https://instagram.com/reel/Cabc/',
      entities: [{ type: 'url', offset: 7, length: 35 }],
    }));
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain('Принял референс');
  });

  it('обычный текст от Юрия → ack "Принял текст"', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({ text: 'надо подумать про чек' }));
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain('Принял текст');
  });

  it('/start от Юрия → приветствие', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    }));
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toMatch(/я на связи/i);
  });

  it('/help от не-Юрия → нет ответа', async () => {
    const { bot, sent } = buildBot(100);
    await bot.handleUpdate(mkUpdate({
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      from: { id: 666, is_bot: false, first_name: 'Other' },
    }));
    expect(sent.length).toBe(0);
  });
});
