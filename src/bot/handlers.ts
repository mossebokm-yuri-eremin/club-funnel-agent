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
  '— /status — что сейчас в работе;\n' +
  '— /refresh_kb — пересчитать эмбеддинги knowledge base;\n' +
  '— /refresh_templates — перечитать SVG-шаблоны каруселей из GDrive;\n' +
  '— /style short|normal|detailed — длина контента.';

function isAuthorized(ctx: Context, allowedUserId: number): boolean {
  return ctx.from?.id === allowedUserId;
}

export function registerHandlers(bot: Bot, opts: RegisterHandlersOptions): void {
  // ---- /start ----
  // Two режима:
  //   1. /start без параметра — это сам Юрий (greeting).
  //   2. /start <code_word> — это лид, пришёл по deep-link из ChatPlace воронки.
  //      Регистрируем subscriber, ставим warmup-цепочку (AC-28), шлём greeting.
  bot.command('start', async (ctx) => {
    const payload = (ctx.match ?? '').toString().trim();
    const fromId = ctx.from?.id;
    if (!fromId) return;

    // Сценарий 1: сам Юрий или admin без payload
    if (!payload) {
      if (isAuthorized(ctx, opts.allowedUserId)) {
        await ctx.reply(GREETING);
        return;
      }
      // Незнакомый юзер без payload — даём вежливый ответ, не блокируем.
      await ctx.reply(
        'Привет. Я бот клуба «Реализация» Юрия Еремина.\n\n' +
          'Если ты пришёл по ссылке из Instagram/Direct — нажми её ещё раз, она содержит код воронки.',
      );
      return;
    }

    // Сценарий 2: payload = code_word воронки. Регистрируем подписчика + цепочка.
    if (!opts.pool) {
      log.warn({}, '/start with payload: pool not wired');
      return;
    }
    try {
      const codeWord = payload.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 60);
      if (!codeWord) {
        await ctx.reply('Не понял код воронки. Попробуй ещё раз по той же ссылке.');
        return;
      }

      // 1. Ищем funnel.
      const fRes = await opts.pool.query<{ id: string; code_word: string; bonus_id: string | null }>(
        `SELECT id, code_word, bonus_id FROM funnels
          WHERE code_word = $1 AND status = 'live' LIMIT 1`,
        [codeWord],
      );
      const funnel = fRes.rows[0];
      if (!funnel) {
        log.warn({ codeWord, fromId }, '/start: unknown code_word');
        await ctx.reply(
          'Привет! Этот код воронки уже не активен. Напиши Юрию в Instagram — отправит свежий.',
        );
        return;
      }

      // 2. Upsert subscriber (по tg_user_id).
      const subRes = await opts.pool.query<{ id: string; status: string }>(
        `INSERT INTO subscribers (tg_user_id, status, last_seen_at)
           VALUES ($1, 'warming', NOW())
         ON CONFLICT (tg_user_id) WHERE tg_user_id IS NOT NULL AND deleted_at IS NULL
           DO UPDATE SET last_seen_at = NOW(),
                         status = CASE WHEN subscribers.status = 'lead' THEN 'warming' ELSE subscribers.status END
         RETURNING id, status`,
        [fromId],
      );
      const subscriberId = subRes.rows[0]!.id;

      // 3. trackEvent: direct_received (метрика — лид дошёл до бота).
      const { trackEvent } = await import('../services/funnel.js');
      await trackEvent(
        {
          subscriberId,
          funnelId: funnel.id,
          codeWord: funnel.code_word,
          eventCode: 'direct_received',
          source: 'tg_bot',
          idempotencyKey: `start:${subscriberId}:${funnel.id}`,
        },
        { pool: opts.pool },
      );

      // 4. Создаём warmup-цепочку (idempotent — повторный /start не дублирует).
      const { scheduleWarmupChain } = await import('../services/warmup-scheduler.js');
      const wm = await scheduleWarmupChain(opts.pool, {
        subscriberId,
        funnelId: funnel.id,
        codeWord: funnel.code_word,
        chainType: 'short',
      });

      // 5. Greeting (первое сообщение warmup отправит worker через ≤5 мин).
      await ctx.reply(
        `Привет! Это бот клуба «Реализация».\n\n` +
          (wm.alreadyExisted
            ? `Ты уже в цепочке прогрева — следующее сообщение пришлю по расписанию.`
            : `Через минуту начну рассказывать про клуб. Всего 3 сообщения за 3 дня — без спама.`),
      );
      log.info(
        { fromId, subscriberId, funnelId: funnel.id, codeWord, ...wm },
        '/start: lead registered + warmup scheduled',
      );
    } catch (err) {
      log.error({ err: (err as Error).message, fromId, payload }, '/start handler failed');
      await ctx.reply('Что-то пошло не так. Напиши Юрию в Instagram, разберёмся.');
    }
  });

  // ---- /help ----
  bot.command('help', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized sender: /help');
      return;
    }
    await ctx.reply(HELP);
  });

  // ---- /refresh_kb ----
  // Пересчитывает эмбеддинги knowledge_embeddings после обновления MD-файлов в knowledge/.
  bot.command('refresh_kb', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized: /refresh_kb');
      return;
    }
    if (!opts.pool) {
      await ctx.reply('pool not wired');
      return;
    }
    await ctx.reply('🔄 Пересчитываю эмбеддинги knowledge base, подожди 30-60 сек…');
    try {
      const { refreshKnowledgeEmbeddings } = await import('../services/knowledge-loader.js');
      const res = await refreshKnowledgeEmbeddings(opts.pool);
      await ctx.reply(
        `✅ Готово.\n` +
          `Всего чанков: ${res.total}\n` +
          `Заново эмбеддено: ${res.embedded}\n` +
          `Без изменений (hash совпал): ${res.skipped}\n` +
          `Удалено осиротевших: ${res.removed}`,
      );
      log.info(res, 'refresh_kb: done');
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ err: msg }, '/refresh_kb: failed');
      await ctx.reply(`❌ Не удалось пересчитать: ${msg.slice(0, 200)}`);
    }
  });

  // ---- /refresh_templates ----
  // Сбрасывает in-memory кэш SVG-шаблонов каруселей. После запуска следующая
  // карусель перечитает шаблоны из GDrive (GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID).
  // Нужно после ручной правки шаблонов в GDrive без ожидания TTL.
  bot.command('refresh_templates', async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized: /refresh_templates');
      return;
    }
    try {
      const { clearTemplateCache } = await import('../services/carousel-template-selector.js');
      clearTemplateCache();
      await ctx.reply(
        '✅ Кэш шаблонов сброшен.\n' +
          'Следующая карусель перечитает структуру эталонных папок из GDrive.',
      );
      log.info({ from: ctx.from?.id }, '/refresh_templates: cache cleared');
    } catch (err) {
      const msg = (err as Error).message;
      log.error({ err: msg }, '/refresh_templates: failed');
      await ctx.reply(`❌ Не удалось сбросить: ${msg.slice(0, 200)}`);
    }
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

  // ---- callback_query: одобрение / regen / edit / reject content_package ----
  // Кнопки в approval-notifier: cp:approve|regen|edit|reject:<UUID>
  bot.callbackQuery(/^cp:(approve|regen|edit|reject):([0-9a-f-]{36})$/, async (ctx) => {
    if (!isAuthorized(ctx, opts.allowedUserId)) {
      log.warn({ from: ctx.from?.id }, 'unauthorized callback');
      await ctx.answerCallbackQuery({ text: 'Нет доступа.' });
      return;
    }
    const m = ctx.match!;
    const action = m[1] as 'approve' | 'regen' | 'edit' | 'reject';
    const pkgId = m[2] as string;
    if (!opts.pool) {
      await ctx.answerCallbackQuery({ text: 'pool not wired' });
      return;
    }
    try {
      const { recordApproval, ideaIdForPackage } = await import('../services/approval-log.js');
      const ideaIdForLog = await ideaIdForPackage(opts.pool, pkgId);

      if (action === 'approve' || action === 'reject') {
        const status = action === 'approve' ? 'approved' : 'rejected';
        await opts.pool.query(
          `UPDATE content_packages SET approval_status = $1, updated_at = NOW() WHERE id = $2`,
          [status, pkgId],
        );
        // AC-24: записываем в approval_log для retrain.
        if (ideaIdForLog) {
          await recordApproval(opts.pool, {
            ideaId: ideaIdForLog,
            artifactType: 'content_package',
            action: action === 'approve' ? 'approved' : 'cancelled',
            voiceCode: 'YE',
          });
        }
        // После ✅ — карусель остаётся в чате с пометкой "Готово к публикации".
        // Юрий публикует сам или пересылает Анне вручную. ANNA_TG_CHAT_ID не используем.
        const label =
          action === 'approve'
            ? '✅ Готово к публикации — опубликуй сам или перешли Анне'
            : '✖ Отклонено';
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await ctx.editMessageText(`✅ content_package_id: \`${pkgId}\`\n\n${label}`, {
          parse_mode: 'Markdown',
        }).catch(() => {});
        await ctx.answerCallbackQuery({ text: label.slice(0, 64) });
        log.info({ pkgId, action, status }, 'approval-callback: status updated');

        // AC-27: на approve — активируем воронку (генерим code_word,
        // создаём ChatPlace scenario, INSERT в funnels). Асинхронно,
        // чтобы не блокировать UI ответ.
        if (action === 'approve' && ideaIdForLog) {
          (async () => {
            try {
              const { activateFunnelOnApprove } = await import(
                '../services/funnel-activator.js'
              );
              const r = await activateFunnelOnApprove(opts.pool!, {
                ideaId: ideaIdForLog,
                contentPackageId: pkgId,
              });
              if (r) {
                await ctx.reply(
                  `🔗 Воронка активирована\n` +
                    `code_word: \`${r.codeWord}\`\n` +
                    `funnel_id: \`${r.funnelId.slice(0, 8)}\`\n` +
                    `ChatPlace: ${r.chatplaceAutomationId ? '✅ ' + r.chatplaceAutomationId.slice(0, 12) : '⚠️ pending'}`,
                  { parse_mode: 'Markdown' },
                );
              }
            } catch (err) {
              log.error(
                { err: (err as Error).message, pkgId, ideaId: ideaIdForLog },
                'approval-callback: funnel-activator failed (non-fatal)',
              );
              await ctx.reply(
                `⚠️ Воронка не активирована: ${(err as Error).message.slice(0, 200)}`,
              ).catch(() => {});
            }
          })();
        }
      } else if (action === 'regen') {
        // Перегенерация — берём idea_id из пакета, ставим новый job в content_queue.
        const ir = await opts.pool.query<{ idea_id: string }>(
          `SELECT idea_id FROM content_packages WHERE id = $1`,
          [pkgId],
        );
        const ideaId = ir.rows[0]?.idea_id;
        if (!ideaId) {
          await ctx.answerCallbackQuery({ text: 'package not found' });
          return;
        }
        // Старый — superseded (reuse 'rejected' enum), новый сейчас встанет в очередь.
        await opts.pool.query(
          `UPDATE content_packages SET approval_status = 'rejected', updated_at = NOW() WHERE id = $1`,
          [pkgId],
        );
        await opts.pool.query(`UPDATE ideas SET status = 'strategy_chosen' WHERE id = $1`, [ideaId]);
        // AC-24: regen = rejected с пометкой в approval_log.
        await recordApproval(opts.pool, {
          ideaId,
          artifactType: 'content_package',
          action: 'rejected',
          voiceCode: 'YE',
          comment: 'regenerate requested via 🔁 button',
        });
        const { contentQueue } = await import('../jobs/queues.js');
        const job = await contentQueue().add(
          'gen',
          { idea_id: ideaId },
          { jobId: `regen-${pkgId}-${Date.now()}` },
        );
        await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
        await ctx.editMessageText(
          `🔄 Перегенерация: idea \`${ideaId.slice(0, 8)}\` → новый пакет на подходе (job ${job.id}).`,
          { parse_mode: 'Markdown' },
        ).catch(() => {});
        await ctx.answerCallbackQuery({ text: '🔄 Перегенерация запущена' });
        log.info({ pkgId, ideaId, newJobId: job.id }, 'approval-callback: regen enqueued');
      } else if (action === 'edit') {
        // Edit-mode: ставим Redis state, ждём следующее сообщение пользователя
        // (текст или голос → STT-инструкция в Phase 8).
        const { setEditState } = await import('../services/edit-state.js');
        await setEditState(ctx.from!.id, pkgId);
        // AC-24: edit armed = commented (комментарий придёт следующим сообщением).
        if (ideaIdForLog) {
          await recordApproval(opts.pool, {
            ideaId: ideaIdForLog,
            artifactType: 'content_package',
            action: 'commented',
            voiceCode: 'YE',
            comment: '✏️ edit mode armed — awaiting instruction',
          });
        }
        await ctx.answerCallbackQuery({ text: '✏️ Жду инструкцию следующим сообщением' });
        await ctx.reply(
          `✏️ *Режим правки* для пакета \`${pkgId.slice(0, 8)}\`.\n\n` +
            `Пиши следующим сообщением ЧТО менять: «короче на 30%», «жёстче, с провокацией», «убери первый абзац», «добавь кейс Ани».\n\n` +
            `Следующее сообщение НЕ создаст новую идею — оно будет применено как правка. ` +
            `Чтобы отменить — /style (или просто игнорируй, через 30 минут state протухнет).`,
          { parse_mode: 'Markdown' },
        );
        log.info({ pkgId, tgUserId: ctx.from!.id }, 'approval-callback: edit-mode armed');
      }
    } catch (err) {
      log.error(
        { err: (err as Error).message, pkgId, action },
        'approval-callback: handler failed',
      );
      await ctx.answerCallbackQuery({ text: 'Ошибка, посмотри логи.' });
    }
  });

  // ---- callback_query: longread outline approval (AC-16) ----
  bot.callbackQuery(
    /^lr:(outline_approve|outline_regen|outline_cancel|draft_approve|draft_regen|draft_edit|draft_reject):([0-9a-f-]{36})$/,
    async (ctx) => {
      if (!isAuthorized(ctx, opts.allowedUserId) || !opts.pool) {
        await ctx.answerCallbackQuery({ text: 'Нет доступа.' });
        return;
      }
      const action = ctx.match![1] as string;
      const ideaId = ctx.match![2] as string;
      const { recordApproval } = await import('../services/approval-log.js');
      // Маппинг lr-action → approval_log.action + artifact_type.
      const logMap: Record<string, { artifactType: 'longread_outline' | 'longread_draft'; act: 'approved' | 'rejected' | 'commented' | 'cancelled'; comment?: string }> = {
        outline_approve: { artifactType: 'longread_outline', act: 'approved' },
        outline_regen: { artifactType: 'longread_outline', act: 'rejected', comment: 'regenerate outline' },
        outline_cancel: { artifactType: 'longread_outline', act: 'cancelled' },
        draft_approve: { artifactType: 'longread_draft', act: 'approved' },
        draft_regen: { artifactType: 'longread_draft', act: 'rejected', comment: 'regenerate draft' },
        draft_edit: { artifactType: 'longread_draft', act: 'commented', comment: '✏️ edit mode armed' },
        draft_reject: { artifactType: 'longread_draft', act: 'cancelled' },
      };
      const logSpec = logMap[action];
      try {
        if (action === 'outline_approve') {
          await opts.pool.query(
            `UPDATE ideas SET status = 'longread_draft_pending' WHERE id = $1`,
            [ideaId],
          );
          // Запускаем фабрику в фоне (через async — не блокируем callback).
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.answerCallbackQuery({ text: '✅ Outline принят, пишу полный лонгрид (1-3 мин)…' });
          (async () => {
            try {
              const { runLongreadDraft } = await import('../services/longread-runner.js');
              await runLongreadDraft(opts.pool!, ideaId);
              const { notifyLongreadDraftReady } = await import('../services/approval-notifier.js');
              await notifyLongreadDraftReady({ ideaId }, { pool: opts.pool! });
            } catch (err) {
              log.error(
                { err: (err as Error).message, ideaId },
                'longread-runner: failed',
              );
            }
          })();
        } else if (action === 'outline_regen') {
          const { generateOutline } = await import('../services/outline-generator.js');
          const ir = await opts.pool.query(
            `SELECT summary, pain_tag FROM ideas WHERE id = $1`,
            [ideaId],
          );
          const r = ir.rows[0];
          if (!r) {
            await ctx.answerCallbackQuery({ text: 'idea not found' });
            return;
          }
          const { outline } = await generateOutline({ summary: r.summary, painTag: r.pain_tag });
          await opts.pool.query(
            `UPDATE ideas SET longread_outline = $2::jsonb, longread_title = $3, longread_code_word = $4 WHERE id = $1`,
            [ideaId, JSON.stringify(outline.sections), outline.title, outline.codeWord],
          );
          const { notifyOutlineReady } = await import('../services/approval-notifier.js');
          await notifyOutlineReady({ ideaId }, { pool: opts.pool });
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.answerCallbackQuery({ text: '🔄 Перегенерирую outline' });
        } else if (action === 'outline_cancel') {
          await opts.pool.query(
            `UPDATE ideas SET status = 'longread_cancelled' WHERE id = $1`,
            [ideaId],
          );
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.editMessageText('✖ Лонгрид отменён.').catch(() => {});
          await ctx.answerCallbackQuery({ text: '✖ Отменён' });
        } else if (action === 'draft_approve') {
          // INSERT в bonus_library с placeholder pdf_url/gdrive_id (Phase 4 заполнит реально).
          const ir = await opts.pool.query(
            `SELECT longread_title, longread_outline, longread_draft_md, pain_tag
               FROM ideas WHERE id = $1`,
            [ideaId],
          );
          const r = ir.rows[0];
          if (!r || !r.longread_draft_md) {
            await ctx.answerCallbackQuery({ text: 'draft missing' });
            return;
          }
          const wordCount = (r.longread_draft_md.match(/[\p{L}\p{N}]+/gu) ?? []).length;
          const ins = await opts.pool.query<{ id: string }>(
            `INSERT INTO bonus_library
               (title, pain_tag, outline, body_md, pdf_url, pdf_gdrive_id, word_count, status, origin, source_idea_id)
             VALUES ($1, $2, $3::jsonb, $4, '', '', $5, 'live', 'strategy_c', $6)
             RETURNING id`,
            [r.longread_title, r.pain_tag, JSON.stringify(r.longread_outline), r.longread_draft_md, wordCount, ideaId],
          );
          const bonusId = ins.rows[0]?.id;
          await opts.pool.query(
            `UPDATE ideas SET status = 'bonus_published', bonus_id = $2 WHERE id = $1`,
            [ideaId, bonusId],
          );
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.answerCallbackQuery({ text: '✅ В библиотеке' });
          await ctx.reply(
            `✅ Лонгрид опубликован в bonus_library: \`${bonusId}\`\n` +
              `Phase 4 добавит PDF + GDrive ссылку.`,
            { parse_mode: 'Markdown' },
          );
          log.info({ ideaId, bonusId, wordCount }, 'longread: published to bonus_library');
        } else if (action === 'draft_regen') {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.answerCallbackQuery({ text: '🔄 Перегенерирую…' });
          (async () => {
            try {
              const { runLongreadDraft } = await import('../services/longread-runner.js');
              await runLongreadDraft(opts.pool!, ideaId);
              const { notifyLongreadDraftReady } = await import('../services/approval-notifier.js');
              await notifyLongreadDraftReady({ ideaId }, { pool: opts.pool! });
            } catch (err) {
              log.error({ err: (err as Error).message, ideaId }, 'longread-regen: failed');
            }
          })();
        } else if (action === 'draft_edit') {
          // Используем edit-state в режиме longread.
          const { setEditState } = await import('../services/edit-state.js');
          // Для лонгрида префикс ставим 'lr:'+ideaId в pkgId (чтобы text-handler понял).
          await setEditState(ctx.from!.id, `lr:${ideaId}`);
          await ctx.answerCallbackQuery({ text: '✏️ Жду инструкцию' });
          await ctx.reply(
            `✏️ *Режим правки лонгрида* \`${ideaId.slice(0, 8)}\`.\n\nПиши что менять (текстом).`,
            { parse_mode: 'Markdown' },
          );
        } else if (action === 'draft_reject') {
          await opts.pool.query(
            `UPDATE ideas SET status = 'longread_rejected' WHERE id = $1`,
            [ideaId],
          );
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
          await ctx.editMessageText('✖ Лонгрид отклонён.').catch(() => {});
          await ctx.answerCallbackQuery({ text: '✖ Отклонён' });
        }
        // AC-24: запись в approval_log для retrain.
        if (logSpec) {
          await recordApproval(opts.pool, {
            ideaId,
            artifactType: logSpec.artifactType,
            action: logSpec.act,
            ...(logSpec.comment ? { comment: logSpec.comment } : {}),
          });
        }
      } catch (err) {
        log.error(
          { err: (err as Error).message, action, ideaId },
          'longread-callback: failed',
        );
        await ctx.answerCallbackQuery({ text: 'Ошибка, смотри логи.' });
      }
    },
  );

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

    // ---- edit-mode: если у юзера активен edit_state, текст — инструкция, не идея ----
    if (m.text && m.text.trim().length > 0 && opts.pool) {
      try {
        const { getEditState, clearEditState } = await import('../services/edit-state.js');
        const state = await getEditState(ctx.from!.id);
        if (state) {
          await clearEditState(ctx.from!.id);
          // Longread edit-mode: pkg_id с префиксом 'lr:' → это idea, не content_package.
          if (state.pkg_id.startsWith('lr:')) {
            const ideaId = state.pkg_id.slice(3);
            await ctx.reply(
              `✏️ Принял инструкцию правки лонгрида: «${m.text.slice(0, 80)}». Регенерирую…`,
              { parse_mode: 'Markdown' },
            );
            (async () => {
              try {
                // Простая стратегия: добавляем инструкцию в outline и перегенерим draft.
                // Полноценный edit-pass через Claude — TODO P2.
                await opts.pool!.query(
                  `UPDATE ideas SET longread_outline = longread_outline || $2::jsonb WHERE id = $1`,
                  [
                    ideaId,
                    JSON.stringify([
                      { h2: 'USER_EDIT_INSTRUCTION', summary: m.text },
                    ]),
                  ],
                );
                const { runLongreadDraft } = await import('../services/longread-runner.js');
                await runLongreadDraft(opts.pool!, ideaId);
                const { notifyLongreadDraftReady } = await import(
                  '../services/approval-notifier.js'
                );
                await notifyLongreadDraftReady({ ideaId }, { pool: opts.pool! });
              } catch (err) {
                log.error(
                  { err: (err as Error).message, ideaId },
                  'longread-edit: failed',
                );
              }
            })();
            return;
          }
          await ctx.reply(
            `✏️ Принял инструкцию правки: «${m.text.slice(0, 80)}». Применяю к пакету \`${state.pkg_id.slice(0, 8)}\`…`,
            { parse_mode: 'Markdown' },
          );
          const { editContentPackage } = await import('../services/content-edit.js');
          const r = await editContentPackage(opts.pool, {
            pkgId: state.pkg_id,
            instruction: m.text,
            tgUserId: ctx.from!.id,
          });
          if (r.status === 'ok' && r.newPkgId) {
            const { visualQueue } = await import('../jobs/queues.js');
            await visualQueue().add(
              'carousel',
              { content_package_id: r.newPkgId },
              { jobId: `edit-vis-${r.newPkgId}` },
            );
            await ctx.reply(
              `✅ Правка применена. Новый пакет \`${r.newPkgId.slice(0, 8)}\` собирается, карусель и уведомление с кнопками придут отдельным сообщением.`,
              { parse_mode: 'Markdown' },
            );
          } else {
            await ctx.reply(`Не получилось применить правку: ${r.reason ?? 'unknown'}.`);
          }
          return;
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, 'edit-mode: failed');
        // fallthrough — обрабатываем как обычный текст
      }
    }

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
