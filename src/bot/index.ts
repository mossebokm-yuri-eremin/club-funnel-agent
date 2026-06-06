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
  /** Явный override allowlist. Если не задан — config.YE_TG_USER_ID + CSV YE_TG_USER_IDS. */
  allowedUserIds?: number[];
  statusProvider?: RegisterHandlersOptions['statusProvider'];
  pool?: Pool;
}

function parseUserIdsCsv(csv: string | undefined): number[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function createBot(opts: CreateBotOptions = {}): Bot {
  const token = opts.token ?? config.TELEGRAM_BOT_TOKEN;
  const allowedUserIds =
    opts.allowedUserIds ??
    Array.from(
      new Set<number>([config.YE_TG_USER_ID, ...parseUserIdsCsv(config.YE_TG_USER_IDS)]),
    );
  log.info({ count: allowedUserIds.length }, 'bot: allowlist loaded');
  const bot = new Bot(token);
  const handlerOpts: RegisterHandlersOptions = { allowedUserIds };
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
  secretToken?: string;
  route?: string;
}

export const telegramWebhookPlugin: FastifyPluginAsync<RegisterBotWebhookOptions> = async (
  app,
  opts,
) => {
  const route = opts.route ?? '/webhook/telegram';
  const handler = opts.secretToken
    ? webhookCallback(opts.bot, 'fastify', { secretToken: opts.secretToken })
    : webhookCallback(opts.bot, 'fastify');

  app.post(route, async (req, reply) => {
    return handler(req, reply);
  });
  log.info({ route, secretToken: Boolean(opts.secretToken) }, 'bot: webhook route registered');
};

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
  await bot.init();
  const pluginOpts: RegisterBotWebhookOptions = { bot };
  if (opts.secretToken) pluginOpts.secretToken = opts.secretToken;
  await app.register(telegramWebhookPlugin, pluginOpts);
  return bot;
}
