// Воронка — SPEC §2.10 + §4.11.
//
// CLAUDE.md §1 (sacred): единственный CTA — клуб «Реализация». Никаких
// промежуточных платных SKU (tripwire/loss-leader/курсы/наставничество).
//
// Что здесь делается:
//   1) sendLongreadToDirect — забирает bonus.pdf_url из bonus_library и просит
//      ChatPlace доставить ссылку подписчику в Direct (AC-27, стратегия A/C);
//      пишет funnel_events.event_type='pdf_delivered'.
//   2) upgradeToClub — переводит подписчика на основной оффер клуба 5000 ₽/мес.
//      Реальная подписка живёт в GetCourse; здесь — только пуш ссылки на оффер
//      и событие 'club_offered'.
//   3) trackEvent — единая точка записи в funnel_events с идемпотентностью.
//   4) markPaymentResolved — фиксирует факт оплаты клуба, который пришёл
//      из GetCourse webhook (или hourly pull).
//
// Все деньги — BIGINT копеек. Никакого float/numeric (CLAUDE.md §4).

import type { Pool, PoolClient } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import type { ChatPlaceClient } from '../integrations/chatplace.js';
import { createChatPlaceClient } from '../integrations/chatplace.js';

export type FunnelEventCode =
  | 'longread_offered'
  | 'pdf_delivered'
  | 'club_offered'
  | 'club_purchased'
  | 'cta_clicked'
  | 'direct_received'
  | 'ig_comment'
  | 'gc_pull_reconcile';

export interface FunnelDeps {
  pool: Pool;
  chatplace?: ChatPlaceClient;
  /** Опциональный override `now()` для детерминированных тестов. */
  now?: () => Date;
}

export interface TrackEventInput {
  subscriberId: string | null;
  funnelId?: string | null;
  codeWord?: string | null;
  eventCode: FunnelEventCode;
  source: 'chatplace' | 'instagram' | 'getcourse' | 'tg_bot' | 'cron_pull';
  payload?: Record<string, unknown>;
  /** Уникальный ключ (idempotency); рекомендуется задавать всегда. */
  idempotencyKey?: string;
  occurredAt?: Date;
}

export interface TrackEventResult {
  inserted: boolean;
  eventId: number | null;
}

function getChatPlace(deps: FunnelDeps): ChatPlaceClient {
  return deps.chatplace ?? createChatPlaceClient();
}

function getNow(deps: FunnelDeps): Date {
  return deps.now ? deps.now() : new Date();
}

// ---------------------------------------------------------------------------
// trackEvent
// ---------------------------------------------------------------------------

export async function trackEvent(input: TrackEventInput, deps: FunnelDeps): Promise<TrackEventResult> {
  const occurredAt = input.occurredAt ?? getNow(deps);
  const payloadJson = JSON.stringify(input.payload ?? {});
  const sql = `
    INSERT INTO funnel_events
      (funnel_id, subscriber_id, code_word, event_type, source, payload, occurred_at, idempotency_key)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id`;
  const res = await deps.pool.query<{ id: number }>(sql, [
    input.funnelId ?? null,
    input.subscriberId,
    input.codeWord ?? null,
    input.eventCode,
    input.source,
    payloadJson,
    occurredAt.toISOString(),
    input.idempotencyKey ?? null,
  ]);
  if (res.rows.length === 0) {
    log.debug({ idempotencyKey: input.idempotencyKey, eventCode: input.eventCode }, 'funnel: duplicate event, skipped');
    return { inserted: false, eventId: null };
  }
  return { inserted: true, eventId: res.rows[0]!.id };
}

// ---------------------------------------------------------------------------
// sendLongreadToDirect (AC-27 strategy A/C)
// ---------------------------------------------------------------------------

export interface SendLongreadResult {
  delivered: boolean;
  pdfUrl: string | null;
  chatplaceMessageId: string | null;
  reason?: string;
}

interface BonusRow {
  id: string;
  title: string;
  pdf_url: string;
  pdf_gdrive_id: string;
  status: string;
}

interface SubscriberRow {
  id: string;
  ig_username: string | null;
  status: string;
}

async function fetchSubscriber(pool: Pool, id: string): Promise<SubscriberRow | null> {
  const r = await pool.query<SubscriberRow>(
    `SELECT id, ig_username, status FROM subscribers
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function fetchBonus(pool: Pool, bonusId: string): Promise<BonusRow | null> {
  const r = await pool.query<BonusRow>(
    `SELECT id, title, pdf_url, pdf_gdrive_id, status FROM bonus_library
      WHERE id = $1 AND deleted_at IS NULL`,
    [bonusId],
  );
  return r.rows[0] ?? null;
}

export async function sendLongreadToDirect(
  subscriberId: string,
  bonusId: string,
  deps: FunnelDeps,
  options: { funnelId?: string | null; codeWord?: string | null; chatplaceSubscriberId?: string } = {},
): Promise<SendLongreadResult> {
  const sub = await fetchSubscriber(deps.pool, subscriberId);
  if (!sub) return { delivered: false, pdfUrl: null, chatplaceMessageId: null, reason: 'subscriber not found / deleted' };
  const bonus = await fetchBonus(deps.pool, bonusId);
  if (!bonus) return { delivered: false, pdfUrl: null, chatplaceMessageId: null, reason: 'bonus not found / deleted' };
  if (bonus.status !== 'live') {
    return { delivered: false, pdfUrl: bonus.pdf_url, chatplaceMessageId: null, reason: `bonus.status=${bonus.status}` };
  }

  const cp = getChatPlace(deps);
  // ChatPlace оперирует своим subscriber_id, не нашим UUID. Если передали
  // явный — используем его, иначе пробуем найти по ig_username.
  let cpSubscriberId = options.chatplaceSubscriberId;
  if (!cpSubscriberId && sub.ig_username) {
    const cpSub = await cp.getSubscriberByIgUsername(sub.ig_username);
    cpSubscriberId = cpSub?.id;
  }
  if (!cpSubscriberId) {
    return {
      delivered: false,
      pdfUrl: bonus.pdf_url,
      chatplaceMessageId: null,
      reason: 'cannot resolve chatplace subscriber',
    };
  }

  const text = `Лови материал «${bonus.title}» — ${bonus.pdf_url}`;
  const res = await cp.sendDirectMessage(cpSubscriberId, text);

  await trackEvent(
    {
      subscriberId,
      funnelId: options.funnelId ?? null,
      codeWord: options.codeWord ?? null,
      eventCode: 'pdf_delivered',
      source: 'chatplace',
      payload: { bonus_id: bonus.id, pdf_gdrive_id: bonus.pdf_gdrive_id, chatplace: res },
      idempotencyKey: `pdf_delivered:${subscriberId}:${bonus.id}`,
    },
    deps,
  );

  return {
    delivered: res.status !== 'failed',
    pdfUrl: bonus.pdf_url,
    chatplaceMessageId: res.message_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// upgradeToClub (5000 ₽/мес — ЕДИНСТВЕННЫЙ CTA, CLAUDE.md §1 sacred)
// ---------------------------------------------------------------------------

export interface UpgradeResult {
  pushed: boolean;
  offerUrl: string | null;
  priceKopecks: number;
  reason?: string;
}

function buildGcOfferUrl(offerId: string, utmCampaign: string): string {
  const base = `https://${config.GC_ACCOUNT ?? 'mossebo'}.getcourse.ru/sales/${encodeURIComponent(offerId)}`;
  const qs = new URLSearchParams({
    utm_source: 'club_funnel',
    utm_campaign: utmCampaign,
  });
  return `${base}?${qs.toString()}`;
}

export async function upgradeToClub(
  subscriberId: string,
  deps: FunnelDeps,
  options: { funnelId?: string | null; codeWord?: string | null; chatplaceSubscriberId?: string } = {},
): Promise<UpgradeResult> {
  const offerId = config.GC_BASE_OFFER_ID;
  if (!offerId) {
    log.error({ subscriberId }, 'funnel: GC_BASE_OFFER_ID not set — club CTA cannot push');
    return {
      pushed: false,
      offerUrl: null,
      priceKopecks: config.GC_BASE_PRICE_KOPECKS,
      reason: 'GC_BASE_OFFER_ID not set',
    };
  }
  const sub = await fetchSubscriber(deps.pool, subscriberId);
  if (!sub) {
    return {
      pushed: false,
      offerUrl: null,
      priceKopecks: config.GC_BASE_PRICE_KOPECKS,
      reason: 'subscriber not found / deleted',
    };
  }

  const campaign = options.codeWord ?? 'club_default';
  const offerUrl = buildGcOfferUrl(offerId, campaign);

  const cp = getChatPlace(deps);
  let cpSubscriberId = options.chatplaceSubscriberId;
  if (!cpSubscriberId && sub.ig_username) {
    const cpSub = await cp.getSubscriberByIgUsername(sub.ig_username);
    cpSubscriberId = cpSub?.id;
  }
  let chatplaceOk = false;
  if (cpSubscriberId) {
    const priceRub = (config.GC_BASE_PRICE_KOPECKS / 100).toFixed(0);
    const res = await cp.sendDirectMessage(
      cpSubscriberId,
      `Готов в клуб «Реализация»? ${priceRub} ₽/мес → ${offerUrl}`,
    );
    chatplaceOk = res.status !== 'failed';
  }

  await trackEvent(
    {
      subscriberId,
      funnelId: options.funnelId ?? null,
      codeWord: options.codeWord ?? null,
      eventCode: 'club_offered',
      source: 'chatplace',
      payload: { offer_id: offerId, offer_url: offerUrl, price_kopecks: config.GC_BASE_PRICE_KOPECKS },
      idempotencyKey: `club_offered:${subscriberId}:${offerId}`,
    },
    deps,
  );

  return {
    pushed: chatplaceOk,
    offerUrl,
    priceKopecks: config.GC_BASE_PRICE_KOPECKS,
  };
}

// ---------------------------------------------------------------------------
// markPaymentResolved — внутренний хелпер: фиксирует факт оплаты, который
// пришёл из GetCourse (webhook или hourly pull). НЕ доверяем суммам/датам из
// внешнего вызова: их источник — gc_order_id в payments.
// ---------------------------------------------------------------------------

export interface ResolvePaymentInput {
  subscriberId: string;
  /** Только клуб — единственный платный SKU (CLAUDE.md §1). */
  productKind: 'club';
  occurredAt?: Date;
  funnelId?: string | null;
  codeWord?: string | null;
  amountKopecks: number; // INTEGER (CLAUDE.md §4)
}

export async function markPaymentResolved(
  input: ResolvePaymentInput,
  deps: FunnelDeps,
): Promise<TrackEventResult> {
  if (!Number.isInteger(input.amountKopecks) || input.amountKopecks <= 0) {
    throw new Error(`funnel: amountKopecks must be positive integer, got ${input.amountKopecks}`);
  }
  const occurredAt = input.occurredAt ?? getNow(deps);

  await deps.pool.query(
    `UPDATE subscribers
        SET status = 'paid',
            club_paid_at = COALESCE(club_paid_at, $2)
      WHERE id = $1 AND deleted_at IS NULL`,
    [input.subscriberId, occurredAt.toISOString()],
  );

  return trackEvent(
    {
      subscriberId: input.subscriberId,
      funnelId: input.funnelId ?? null,
      codeWord: input.codeWord ?? null,
      eventCode: 'club_purchased',
      source: 'getcourse',
      payload: { amount_kopecks: input.amountKopecks },
      idempotencyKey: `club_purchased:${input.subscriberId}:${occurredAt.toISOString()}`,
      occurredAt,
    },
    deps,
  );
}

// Экспортируем internals для тестов
export const __internals = { buildGcOfferUrl };

// Удерживаем PoolClient в типах, чтобы caller мог вызывать функции из транзакции,
// если потребуется (текущая реализация работает на pool — каждая операция
// атомарна сама по себе).
export type FunnelTxClient = PoolClient;
