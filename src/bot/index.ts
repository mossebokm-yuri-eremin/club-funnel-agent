// Инициализация grammY-бота и его Fastify-плагина (POST /webhook/telegram).
// Webhook режим — не polling. Telegram secret-token из TG_WEBHOOK_SECRET.

import { Bot, webhookCallback } from 'grammy';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { registerHandlers, type RegisterHandlersOptions } from './handlers.js';

export interface CreateBotOptions {
  token?: string;
  allowedUserId?: number;
  statusProvider?: RegisterHandlersOptions['statusProvider'];
  pool?: Pool;
}

export function createBot(opts: CreateBotOptions = {}): Bot {
  const token = opts.token ?? config.TELEGRAM_BOT_TOKEN;
  const allowedUserId = opts.allowedUserId ?? config.YE_TG_USER_ID;
  const bot = new Bot(token);
  const handlerOpts: RegisterHandlersOptions = { allowedUserId };
  if (opts.statusProvider) handlerOpts.statusProvider = opts.statusProvider;
  if (opts.pool) handlerOpts.pool = opts.pool;
  registerHandlers(bot, handlerOpts);
  bot.catch((err) => {
    log.error({ err: err.message, ctx: err.ctx?.update?.update_id }, 'bot: handler crashed');
  });
  return bot;
}

export interface RegisterBotWebhookOptions {
  bot: Bot;
  /** Telegram secret-token для X-Telegram-Bot-Api-Secret-Token. Из TG_WEBHOOK_SECRET. */
  secretToken?: string;
  route?: string;
}

/**
 * Подключает grammY к Fastify через POST {route} (по умолчанию /webhook/telegram).
 *
 * Важно: Fastify content-type parser для JSON уже выставлен GetCourse-плагином
 * (он сохраняет raw body). Это не мешает grammY — он читает уже parsed `req.body`.
 */
export const telegramWebhookPlugin: FastifyPluginAsync<RegisterBotWebhookOptions> = async (
  app,
  opts,
) => {
  const route = opts.route ?? '/webhook/telegram';
  const handler = opts.secretToken
    ? webhookCallback(opts.bot, 'fastify', { secretToken: opts.secretToken })
    : webhookCallback(opts.bot, 'fastify');

  app.post(route, async (req, reply) => {
    // grammY FastifyAdapter принимает {body, headers} + reply.code/status/send.
    return handler(req, reply);
  });
  log.info({ route, secretToken: Boolean(opts.secretToken) }, 'bot: webhook route registered');
};

/**
 * Регистрирует webhook у Telegram. Должен вызываться один раз при деплое
 * или при старте, если URL изменился. В тестах не вызывается.
 */
export async function setTelegramWebhook(
  bot: Bot,
  publicBaseUrl: string,
  secretToken?: string,
): Promise<void> {
  const url = `${publicBaseUrl.replace(/\/$/, '')}/webhook/telegram`;
  await bot.api.setWebhook(url, secretToken ? { secret_token: secretToken } : undefined);
  log.info({ url, hasSecret: Boolean(secretToken) }, 'bot: setWebhook ok');
}

export async function bootstrapBot(
  app: FastifyInstance,
  opts: CreateBotOptions & { secretToken?: string } = {},
): Promise<Bot> {
  const bot = createBot(opts);
  // grammY требует initialization (для ME, commands и т.п.). Делаем явно.
  await bot.init();
  const pluginOpts: RegisterBotWebhookOptions = { bot };
  if (opts.secretToken) pluginOpts.secretToken = opts.secretToken;
  await app.register(telegramWebhookPlugin, pluginOpts);
  return bot;
}
