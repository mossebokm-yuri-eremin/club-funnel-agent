import crypto from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { log } from '../observability/logger.js';

// Заголовок подписи: SPEC §9.4 → 'x-gc-signature' (lower-case в fastify).
// HTTP-заголовки case-insensitive; Fastify нормализует к lowercase.
// В ТЗ для подрядчика — X-GetCourse-Signature (см. docs/tz-getcourse-webhook.md).
export const GC_SIGNATURE_HEADER = 'x-getcourse-signature';
// Старое имя оставляем как fallback на случай, если подрядчик уже настроил с ним.
export const GC_SIGNATURE_HEADER_LEGACY = 'x-gc-signature';
// TTL для ключей идемпотентности: 7 дней. GetCourse может ретраить webhook
// несколько раз; 7 суток — с запасом перекрывает SLA и pull-reconcile.
// TODO confirm with Yuri: уточнить SLA ретраев GC.
export const DEFAULT_IDEMPOTENCY_TTL_SEC = 60 * 60 * 24 * 7;

export interface IdempotencyStore {
  /** Возвращает true, если ключ был установлен впервые; false — если уже существовал. */
  acquire(key: string, ttlSeconds: number): Promise<boolean>;
}

// Минимальный интерфейс ioredis, который нам нужен. Не тянем тип Redis из ioredis,
// чтобы webhook оставался тестируемым без реального клиента.
export interface RedisLike {
  set(
    key: string,
    value: string,
    nxMode: 'NX',
    ttlMode: 'EX',
    ttlSeconds: number,
  ): Promise<'OK' | null>;
}

export function redisIdempotencyStore(redis: RedisLike): IdempotencyStore {
  return {
    async acquire(key, ttlSeconds) {
      const r = await redis.set(key, '1', 'NX', 'EX', ttlSeconds);
      return r === 'OK';
    },
  };
}

// Поддерживаем два формата:
//   1) Плоский x-www-form-urlencoded из GC UI (см. скриншот настроек):
//      event, order_id, user_id, user_email, user_name, offer_id, offer_name,
//      amount, paid_at, utm_source, utm_campaign, utm_content
//   2) Старый вложенный JSON: { action, deal: { id, user: { email }, ... }, timestamp }
export interface GetCourseDealPayload {
  // --- плоский формат GC UI ---
  event?: string;
  order_id?: string | number;
  user_id?: string | number;
  user_email?: string;
  user_name?: string;
  offer_id?: string | number;
  offer_name?: string;
  amount?: string | number;
  paid_at?: string;
  utm_source?: string;
  utm_campaign?: string;
  utm_content?: string;
  // --- старый вложенный формат (legacy) ---
  action?: string;
  deal?: {
    id?: string | number;
    status?: string;
    user?: { email?: string; phone?: string; first_name?: string };
    offer_id?: string | number;
    amount?: string | number;
    currency?: string;
    utm?: Record<string, string>;
    paid_at?: string;
  };
  timestamp?: number;
  [k: string]: unknown;
}

export interface ProcessedResult {
  /** true → выполнили реальную обработку, false → дубликат, пропустили. */
  processed: boolean;
  eventId: string;
}

export interface RegisterGetCourseWebhookOptions {
  secret: string;
  idempotency: IdempotencyStore;
  /** Бизнес-обработчик. Вызывается ТОЛЬКО после успешного HMAC и первой acquire. */
  onPayload?: (payload: GetCourseDealPayload, ctx: { eventId: string; raw: Buffer }) => Promise<void> | void;
  /** Префикс ключей в redis. По умолчанию 'idemp:gc-webhook'. */
  idempotencyKeyPrefix?: string;
  idempotencyTtlSec?: number;
  route?: string;
}

// HMAC-SHA256 hex, как описано в SPEC §6.2 и §9.4.
export function verifyHmac(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Сравниваем lower-case; GC присылает hex, регистр не критичен.
  const got = signatureHeader.trim().toLowerCase();
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
  } catch {
    return false;
  }
}

export function eventIdFromPayload(payload: GetCourseDealPayload): string {
  // Поддержка двух форматов GC payload:
  //   - плоский (event, order_id) — из UI настроек webhook'a GetCourse
  //   - вложенный (action, deal.id) — старый legacy
  // Идемпотентность: event/action + order_id/deal.id + timestamp/paid_at.
  const action = (payload.event ?? payload.action ?? 'unknown').toString();
  const dealId =
    payload.order_id !== undefined
      ? String(payload.order_id)
      : payload.deal?.id !== undefined
        ? String(payload.deal.id)
        : null;
  const ts =
    payload.paid_at !== undefined
      ? String(payload.paid_at)
      : payload.timestamp !== undefined
        ? String(payload.timestamp)
        : '0';
  if (dealId) return `${action}:${dealId}:${ts}`;
  const h = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return `${action}:noid:${h}`;
}

function getRawBody(req: FastifyRequest): Buffer | null {
  const raw = (req as FastifyRequest & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  return null;
}

// Регистрирует content-type parsers для application/json И application/x-www-form-urlencoded,
// сохраняющие raw body для HMAC-проверки. GetCourse шлёт x-www-form-urlencoded (см. их UI
// "Тело запроса"), Stripe-подобные интеграции — JSON. Поддерживаем оба.
// Должен вызываться один раз на инстансе fastify (idempotent — повторный вызов
// не падает, мы ловим исключение типа FST_ERR_CTP_ALREADY_PRESENT).
function parseFormUrlEncoded(raw: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  const text = raw.toString('utf8');
  if (!text) return out;
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawVal = eq >= 0 ? pair.slice(eq + 1) : '';
    try {
      const k = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      const v = decodeURIComponent(rawVal.replace(/\+/g, ' '));
      out[k] = v;
    } catch {
      out[rawKey] = rawVal;
    }
  }
  return out;
}

export function ensureRawBodyParser(app: FastifyInstance): void {
  const addParser = (mime: string, parser: (raw: Buffer) => unknown): void => {
    try {
      app.addContentTypeParser(mime, { parseAs: 'buffer' }, (req, body, done) => {
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
        try {
          const parsed = (body as Buffer).length === 0 ? {} : parser(body as Buffer);
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== 'FST_ERR_CTP_ALREADY_PRESENT') throw err;
    }
  };

  addParser('application/json', (raw) => JSON.parse(raw.toString('utf8')));
  addParser('application/x-www-form-urlencoded', (raw) => parseFormUrlEncoded(raw));
}

export const getCourseWebhookPlugin: FastifyPluginAsync<RegisterGetCourseWebhookOptions> = async (
  app,
  opts,
) => {
  const route = opts.route ?? '/webhook/getcourse';
  const keyPrefix = opts.idempotencyKeyPrefix ?? 'idemp:gc-webhook';
  const ttl = opts.idempotencyTtlSec ?? DEFAULT_IDEMPOTENCY_TTL_SEC;

  ensureRawBodyParser(app);

  app.post(route, async (req, reply) => {
    const raw = getRawBody(req);
    if (!raw) {
      log.warn({ ip: req.ip }, 'gc-webhook: missing raw body');
      return reply.code(400).send({ error: 'missing_body' });
    }

    const sig = req.headers[GC_SIGNATURE_HEADER] ?? req.headers[GC_SIGNATURE_HEADER_LEGACY];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;

    if (!verifyHmac(raw, sigStr, opts.secret)) {
      log.warn({ ip: req.ip, hasHeader: Boolean(sigStr) }, 'gc-webhook: invalid HMAC');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    const payload = (req.body ?? {}) as GetCourseDealPayload;
    const eventId = eventIdFromPayload(payload);
    const key = `${keyPrefix}:${eventId}`;

    const acquired = await opts.idempotency.acquire(key, ttl);
    if (!acquired) {
      log.info({ eventId }, 'gc-webhook: duplicate, skipping handler');
      const result: ProcessedResult = { processed: false, eventId };
      return reply.code(200).send(result);
    }

    if (opts.onPayload) {
      try {
        await opts.onPayload(payload, { eventId, raw });
      } catch (err) {
        // Намеренно не отдаём 5xx наружу: payload уже валиден (HMAC ok), а GC
        // ретраит — это создаст шум. Кладём в DLQ через лог, разберём отдельно.
        // TODO confirm with Yuri: либо вернуть 500 для авто-ретрая GC,
        // либо явный async DLQ (BullMQ webhook_dlq из SPEC §3.5).
        log.error({ err, eventId }, 'gc-webhook: handler failed; logged for DLQ');
      }
    }

    const result: ProcessedResult = { processed: true, eventId };
    return reply.code(200).send(result);
  });
};

export default getCourseWebhookPlugin;
