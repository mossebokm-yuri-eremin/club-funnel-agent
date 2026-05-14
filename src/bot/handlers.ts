// Хендлеры grammY. SPEC §2.1 (AC-1..AC-3) + §2.13 + §5.11.
// Каждое сообщение проходит through:
//   1) allowlist (только YE_TG_USER_ID),
//   2) детектор референса (reference-detector),
//   3) роутинг: voice/audio → audio_queue; reference → reference_dl_queue;
//      команды (/start, /help, /status) — inline.
//
// Перед enqueue сразу пишем «Принял …» сообщение пользователю, чтобы Юрий видел,
// что бот живой (AC-1: «Принял голосовое, расшифровываю»).

import type { Bot, Context } from 'grammy';
import type { Pool } from 'pg';
import { log } from '../observability/logger.js';
import { detectReference, type DetectableMessage } from '../services/reference-detector.js';
import {
  audioQueue,
  referenceDlQueue,
  type SttJobData,
  type ReferenceDetectJobData,
} from '../jobs/queues.js';

export interface RegisterHandlersOptions {
  allowedUserId: number;
  /** Для статусной команды — функция, возвращающая текущие счётчики. */
  statusProvider?: () => Promise<BotStatus> | BotStatus;
  /** Для callback-handlers одобрения content_package. Если не задан — кнопки не реагируют. */
  pool?: Pool;
}

export interface BotStatus {
  activeIdeas: number;
  pendingReferences: number;
  contentPackagesInReview: number;
}

const GREETING =
  'Привет, Юрий. Я на связи. Кидай голосовое с идеей или пересылай Reels — приму и положу в работу.';

const HELP =
  'Что умею:\n' +
  '— голосовое → расшифрую и сделаю идею;\n' +
  '— пересланный Reels/пост из Instagram → возьму как референс, жду голос с углом;\n' +
  '— /status — что сейчас в работе.';

function isAuthorized(ctx: Context, allowedUserId: number): boolean {
  return ctx.from?.id === allowedUserId;
}

export function registerHandlers(bot: Bot, opts: RegisterHandlersOptions): void {
  // ---- /start ----
  bot.command('start', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: /start');
      return;
    }
    await ctx.reply(GREETING);
  });

  // ---- /help ----
  bot.command('help', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: /help');
      return;
    }
    await ctx.reply(HELP);
  });

  // ---- /style ----
  // /style short | normal | detailed — переключает длину контента (user_preferences).
  bot.command('style', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized: /style');
      return;
    }
    const arg = (ctx.match ?? '').toString().trim().toLowerCase();
    if (!opts.pool) {
      await ctx.reply('Стили доступны после следующего рестарта (pool not wired).');
      return;
    }
    const { isValidStyle, setUserStyle, getUserStyle } = await import(
      '../services/user-preferences.js'
    );
    if (!arg) {
      const current = await getUserStyle(opts.pool, ctx.from!.id);
      await ctx.reply(
        `Текущий стиль: *${current}*\n\n` +
          `Доступно:\n` +
          `• /style short — коротко (TG 150–250 слов, Reels ≤80, слайды 1 предложение)\n` +
          `• /style normal — средне (TG 300–500 слов)\n` +
          `• /style detailed — подробно (TG 500–800 слов)`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
    if (!isValidStyle(arg)) {
      await ctx.reply(`Не понял. Доступно: short | normal | detailed.`);
      return;
    }
    try {
      await setUserStyle(opts.pool, ctx.from!.id, arg);
      log.info({ tg_user_id: ctx.from!.id, style: arg }, 'style: updated');
      await ctx.reply(`✅ Стиль контента установлен: *${arg}*. Применится со следующего голосового.`, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      log.error({ err: (err as Error).message }, '/style: persist failed');
      await ctx.reply('Не смог сохранить стиль, посмотри логи.');
    }
  });

  // ---- /status ----
  bot.command('status', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: /status');
      return;
    }
    if (!opts.statusProvider) {
      await ctx.reply('Статистика будет доступна после Фазы 3.');
      return;
    }
    try {
      const s = await opts.statusProvider();
      await ctx.reply(
        `Идеи в работе: ${s.activeIdeas}\n` +
          `Референсы без угла: ${s.pendingReferences}\n` +
          `Пакеты на согласовании: ${s.contentPackagesInReview}`,
      );
    } catch (err) {
      log.error({ err }, 'status: provider failed');
      await ctx.reply('Не смог собрать статус, посмотри логи.');
    }
  });

  // ---- callback_query: одобрение content_package ----
  // Кнопки в approval-notifier: cp:approve|reject|comment|cancel:<UUID>
  bot.callbackQuery(/^cp:(approve|reject|comment|cancel):([0-9a-f-]{36})$/, async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized callback');
      await ctx.answerCallbackQuery({ text: 'Нет доступа.' });
      return;
    }
    const m = ctx.match!;
    const action = m[1] as 'approve' | 'reject' | 'comment' | 'cancel';
    const pkgId = m[2] as string;
    if (!opts.pool) {
      await ctx.answerCallbackQuery({ text: 'pool not wired' });
      return;
    }
    try {
      if (action === 'approve' || action === 'reject' || action === 'cancel') {
        const status = action === 'approve' ? 'approved' : 'rejected';
        await opts.pool.query(
          `UPDATE content_packages SET approval_status = $1, updated_at = NOW() WHERE id = $2`,
          [status, pkgId],
        );
        const label =
          action === 'approve'
            ? '✅ Принято'
            : action === 'reject'
              ? '🔄 Переделать — пришли голосовое с правками'
              : '❌ Отменено';
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await ctx.editMessageText(
          `✅ content_package_id: \`${pkgId}\`\n\n${label}`,
          { parse_mode: 'Markdown' },
        ).catch(() => {});
        await ctx.answerCallbackQuery({ text: label });
        log.info({ pkgId, action, status }, 'approval-callback: status updated');
      } else if (action === 'comment') {
        await ctx.answerCallbackQuery({
          text: 'Жду текстовый комментарий следующим сообщением — добавлю в пакет.',
          show_alert: false,
        });
        // Сохраним «жду коммент» через note: добавим в БД маркер;
        // полноценный conversation flow — позже (AC-22).
        await opts.pool.query(
          `UPDATE content_packages
              SET validator_report = COALESCE(validator_report, '{}'::jsonb)
                                     || jsonb_build_object('awaiting_comment_at', NOW()),
                  updated_at = NOW()
            WHERE id = $1`,
          [pkgId],
        );
        await ctx.reply(
          `💬 Жду твой комментарий следующим сообщением — приложу к пакету \`${pkgId.slice(0, 8)}\`.`,
          { parse_mode: 'Markdown' },
        );
        log.info({ pkgId }, 'approval-callback: comment requested');
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, pkgId, action },
        'approval-callback: handler failed',
      );
      await ctx.answerCallbackQuery({ text: 'Ошибка, посмотри логи.' });
    }
  });

  // ---- voice / audio ----
  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: voice/audio');
      return;
    }
    const m = ctx.message!;
    const file = m.voice ?? m.audio;
    if (!file) return;

    const jobData: SttJobData = {
      source: { kind: 'tg_file', fileId: file.file_id },
      tg_user_id: ctx.from!.id,
      message_id: m.message_id,
      origin: m.voice ? 'voice' : 'audio',
      ...(file.mime_type !== undefined ? { mime_type: file.mime_type } : {}),
      ...(file.duration !== undefined ? { duration_sec: file.duration } : {}),
    };

    try {
      const job = await audioQueue().add('transcribe', jobData, {
        jobId: `tg:${ctx.from!.id}:${m.message_id}`, // idempotency
      });
      log.info(
        { jobId: job.id, tg_user_id: ctx.from!.id, message_id: m.message_id },
        'audio enqueued for STT',
      );
      await ctx.reply('Принял голосовое, расшифровываю.');
    } catch (err) {
      log.error({ err }, 'audio enqueue failed');
      await ctx.reply('Не смог принять голосовое — попробуй ещё раз.');
    }
  });

  // ---- text / reference forward ----
  bot.on('message', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: message');
      return;
    }
    const m = ctx.message;
    if (!m) return;
    // voice/audio уже обработаны выше; команды — тоже.
    if (m.voice || m.audio) return;
    if ((m.text ?? '').startsWith('/')) return;

    const detectable: DetectableMessage = toDetectable(m);
    const detection = detectReference(detectable);

    if (detection.isReference) {
      const jobData: ReferenceDetectJobData = {
        tg_user_id: ctx.from!.id,
        message_id: m.message_id,
        detection: {
          source: detection.source ?? 'unknown',
          confidence: detection.confidence,
          ...(detection.mediaUrl !== undefined ? { mediaUrl: detection.mediaUrl } : {}),
          ...(detection.captionText !== undefined ? { captionText: detection.captionText } : {}),
        },
        ...(m.video?.file_id ? { video_file_id: m.video.file_id } : {}),
        ...(m.photo && m.photo.length
          ? { photo_file_ids: m.photo.map((p) => p.file_id) }
          : {}),
      };
      try {
        const job = await referenceDlQueue().add('download', jobData, {
          jobId: `ref:${ctx.from!.id}:${m.message_id}`,
        });
        log.info(
          {
            jobId: job.id,
            detectionSource: detection.source,
            confidence: detection.confidence,
          },
          'reference enqueued',
        );
        await ctx.reply('Принял референс. Жду голосовое с углом подачи.');
      } catch (err) {
        log.error({ err }, 'reference enqueue failed');
        await ctx.reply('Принял референс, но в очередь не положил — посмотри логи.');
      }
      return;
    }

    // Иначе — обычный текст. AC-2: source='text'. Фактическая запись в `ideas`
    // делается в Фазе 3 через тот же путь, что и stt. Пока — ack.
    if (m.text && m.text.trim().length > 0) {
      log.info(
        { from: ctx.from?.id, message_id: m.message_id, len: m.text.length },
        'text message received (idea draft)',
      );
      await ctx.reply('Принял текст. Сделаю из него идею.');
    }
  });

  log.info('bot: handlers registered');
}

// ---- helpers ----

function toDetectable(m: NonNullable<Context['message']>): DetectableMessage {
  const out: DetectableMessage = { message_id: m.message_id };
  if (m.text !== undefined) out.text = m.text;
  if (m.caption !== undefined) out.caption = m.caption;
  if (m.entities) out.entities = m.entities;
  if (m.caption_entities) out.caption_entities = m.caption_entities;
  if (m.forward_origin) out.forward_origin = m.forward_origin;
  if (m.video) out.video = m.video;
  if (m.animation) out.animation = m.animation;
  if (m.photo) out.photo = m.photo;
  if (m.document) out.document = m.document;
  if (m.via_bot?.username) out.via_bot = { username: m.via_bot.username };
  return out;
}
