// warmup-scheduler — INSERT прогревочную цепочку в warmup_messages
// после того как подписчик открыл TG бот по deep link /start <code_word>.
//
// SPEC AC-28: 3-5 сообщений с интервалом 1 день, UTM-метка на ссылке клуба.
// SPEC AC-30: длинная цепочка после 7 дней без оплаты, 8 нед × 1/нед.
//
// Контент короткой цепочки (3 сообщения) — пока статически в коде. TODO P1:
// подтянуть из winning_patterns по pain_tag (когда AC-35 заработает).

import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export type ChainType = 'short' | 'long';

interface WarmupTemplate {
  body: string;
  delayHours: number;
}

/** Same-day-close: 4 сообщения за первые 24 часа, дожимаем до покупки в день обращения. */
const SHORT_CHAIN: readonly WarmupTemplate[] = [
  {
    // T+0 (сразу как /start). Видео-привет + лонгрид + первое CTA.
    delayHours: 0,
    body:
      'Привет! Это Юрий Еремин.\n\n' +
      'Держи лонгрид: {LONGREAD_URL}\n\n' +
      'Прочитай — это твой первый шаг. Внутри метод, который уже применяют 7 из 10 резидентов клуба.\n\n' +
      '{GREETING_VIDEO_NOTE}' +
      'Через пару часов вернусь — расскажу как зайти в клуб тем же путём.',
  },
  {
    // T+2h: дожим. Социальное доказательство + первая мягкая ссылка.
    delayHours: 2,
    body:
      'Прочитал?\n\n' +
      'Анна Кацапова из Самары пришла с тем же чеком что у тебя сейчас. За 6 месяцев — 350 000 ₽ за проект. Не за счёт новых дипломов. За счёт упаковки.\n\n' +
      'Так вот. В клубе разбираем именно это — по твоим текущим проектам, на твоих клиентах.\n\n' +
      'Заходи: {CTA_URL}',
  },
  {
    // T+8h: финальный пуш Day 0. «Сегодня — лучший день начать».
    delayHours: 8,
    body:
      'Один день — один сдвиг.\n\n' +
      'Каждый кто оплачивает клуб до конца дня — попадает на вечерний разбор в среду. Я разбираю кейсы резидентов вживую. ' +
      'Послезавтра ты можешь принести свою ситуацию.\n\n' +
      'Заходи: {CTA_URL}\n\n' +
      'Если нужна минута подумать — ок. Завтра напишу ещё раз с другого угла.',
  },
  {
    // T+24h: Day 1. Кейс ученика. Если не купил — даём ещё попытку.
    delayHours: 24,
    body:
      'Ты не купил вчера. Норм. Сегодня — другой угол.\n\n' +
      'Наталия из Хабаровска три месяца думала «надо или не надо». Зашла в клуб — на первой же неделе закрыла проект за 280 000 ₽. Не потому что повезло. Потому что в чате задала один вопрос, который сама бы не нашла.\n\n' +
      'Окружение делает половину работы. Заходи: {CTA_URL}',
  },
] as const;

/** Длинная цепочка: 8 недель × 1/нед (AC-30, после 7 дней без оплаты). */
const LONG_CHAIN: readonly WarmupTemplate[] = [
  // TODO P1: подтянуть top-8 winning_patterns по pain_tag когда AC-35 заработает.
  // Сейчас — заглушка на 4 недели общими полезными постами.
  {
    delayHours: 168,
    body:
      'Неделя прошла — заскочу ещё раз.\n\n' +
      'Самая дешёвая вещь в дизайн-бизнесе — ошибиться с позиционированием. Самая дорогая — нанимать клиентов «по жалости».\n\n' +
      'Если решил отложить клуб — ок. Я ещё напишу через неделю, что-то полезное.',
  },
  {
    delayHours: 336,
    body:
      'Две недели. Короткий вопрос:\n\n' +
      'Сколько сейчас стоит твой час? (не «по чеку», а реально: твой доход / часы работы за месяц)\n\n' +
      'Если ответ ниже 1500 ₽/час — у нас в клубе разбирали ровно эту тему. Если интересно — заходи: {CTA_URL}',
  },
  {
    delayHours: 504,
    body:
      'Три недели. Не пишу часто специально.\n\n' +
      'В клубе с этой недели — серия эфиров «Как закрыть проект от 1 млн ₽ в регионе 200 тыс. населения». ' +
      'Олеся из Нижнего Новгорода и Айша из Махачкалы — практические разборы.\n\n' +
      'Заходи: {CTA_URL}',
  },
  {
    delayHours: 672,
    body:
      'Месяц с момента нашего знакомства. Финал прогрева — без слёзовыжималовки.\n\n' +
      'Если за месяц ты ничего не изменил в подходе — это нормально. У 80% так. Это не лень — это «нет окружения и нет давления».\n\n' +
      'Клуб даёт и то и другое. Решай: {CTA_URL}\n\n' +
      'Дальше писать не буду — ты в списке «дочитал, не зашёл». Сюрприз: иногда такие возвращаются через полгода. Жду.',
  },
] as const;

function pickChain(type: ChainType): readonly WarmupTemplate[] {
  return type === 'long' ? LONG_CHAIN : SHORT_CHAIN;
}

export interface ScheduleWarmupInput {
  subscriberId: string;
  funnelId: string;
  codeWord: string;
  chainType?: ChainType;
  bonusId?: string | null;
}

export interface ScheduleWarmupResult {
  inserted: number;
  alreadyExisted: boolean;
}

/**
 * Создаёт цепочку warmup_messages для подписчика+funnel. Идемпотентно:
 * если уже создана (по UNIQUE step+subscriber+funnel+chain_type) — пропускаем.
 */
export async function scheduleWarmupChain(
  pool: Pool,
  input: ScheduleWarmupInput,
): Promise<ScheduleWarmupResult> {
  const chainType: ChainType = input.chainType ?? 'short';
  const templates = pickChain(chainType);

  // CTA url: TG bot start_link с UTM + ссылка на GC оффер с UTM-меткой code_word.
  // Реальный кликер вернётся в funnel_events через события click_cta_warmup (TODO).
  const ctaBase = config.GC_API_BASE.replace(/\/pl\/api.*$/, '');
  const offerId = config.GC_BASE_OFFER_ID;
  const ctaUrl = offerId
    ? `${ctaBase}/cms/system/payment/order?offer_id=${offerId}&utm_source=club_funnel&utm_campaign=${input.codeWord}`
    : `${ctaBase}?utm_source=club_funnel&utm_campaign=${input.codeWord}`;

  // Идемпотентность: проверяем что цепочка ещё не создавалась.
  const existing = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM warmup_messages
      WHERE subscriber_id = $1 AND funnel_id = $2 AND chain_type = $3`,
    [input.subscriberId, input.funnelId, chainType],
  );
  if (Number(existing.rows[0]?.count ?? '0') > 0) {
    log.info(
      { subscriberId: input.subscriberId, funnelId: input.funnelId, chainType },
      'warmup-scheduler: chain already exists, skipping',
    );
    return { inserted: 0, alreadyExisted: true };
  }

  const now = Date.now();
  let inserted = 0;
  for (let i = 0; i < templates.length; i++) {
    const tpl = templates[i]!;
    const scheduledAt = new Date(now + tpl.delayHours * 3600_000);
    let body = tpl.body.replace(/\{CTA_URL\}/g, ctaUrl);
    const longreadUrl = config.LONGREAD_PUBLIC_BASE
      ? `${config.LONGREAD_PUBLIC_BASE.replace(/\/$/, '')}/longread/${input.bonusId ?? input.funnelId}`
      : ctaUrl;
    body = body.replace(/\{LONGREAD_URL\}/g, longreadUrl);
    const videoNote = config.YURI_GREETING_VIDEO_URL
      ? `Видео-привет: ${config.YURI_GREETING_VIDEO_URL}\n\n`
      : '';
    body = body.replace(/\{GREETING_VIDEO_NOTE\}/g, videoNote);
    try {
      await pool.query(
        `INSERT INTO warmup_messages
           (subscriber_id, funnel_id, step, chain_type, body_md, scheduled_at, cta_url, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         ON CONFLICT (subscriber_id, funnel_id, step, chain_type) DO NOTHING`,
        [
          input.subscriberId,
          input.funnelId,
          i + 1,
          chainType,
          body,
          scheduledAt,
          ctaUrl,
        ],
      );
      inserted++;
    } catch (err) {
      log.warn(
        { err: (err as Error).message, step: i + 1 },
        'warmup-scheduler: insert failed for step',
      );
    }
  }

  log.info(
    {
      subscriberId: input.subscriberId,
      funnelId: input.funnelId,
      chainType,
      inserted,
    },
    'warmup-scheduler: chain scheduled',
  );
  return { inserted, alreadyExisted: false };
}
