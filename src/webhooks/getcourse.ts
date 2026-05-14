// GetCourse webhook — raw-events буфер.
//
// Логика (по решению Юрия 2026-05-14):
//   1. Принимаем ЛЮБОЙ POST на /webhook/getcourse (JSON или x-www-form-urlencoded).
//   2. Сохраняем raw_payload + headers + IP в таблицу getcourse_raw_events.
//   3. Всегда отвечаем 200 OK — GetCourse ответ не парсит, retry'ить нам не нужно.
//   4. HMAC опционален: если подпись пришла — валидируем и пишем hmac_valid=true/false,
//      если не пришла — hmac_valid=NULL (warning в логи, но не отказываем).
//   5. Парсинг → getcourse-parser-worker.ts (раз в 10 сек) → subscribers + Telegram notify.
//
// Sacred (CLAUDE.md §4): деньги в копейках (integer × 100), float — запрещены.

import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { log } from '../observability/logger.js';

// Заголовки подписи (case-insensitive в Fastify → lowercase).
export const GC_SIGNATURE_HEADER = 'x-getcourse-signature';
export const GC_SIGNATURE_HEADER_LEGACY = 'x-gc-signature';

export interface RegisterGetCourseWebhookOptions {
  /** HMAC-секрет. Если опциональный (подрядчик не настроил) — НЕ отбраковываем. */
  secret: string;
  /** PG pool — нужен чтобы писать в getcourse_raw_events. */
  pool: Pool;
  route?: string;
}

// HMAC-SHA256 hex. Возвращает true / false / null (null = заголовка не было).
export function verifyHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean | null {
  if (!signatureHeader) return null;
  if (!secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = signatureHeader.trim().toLowerCase();
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
  } catch {
    return false;
  }
}

// --- raw body parser (json + form-urlencoded) --------------------------------

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
      out[decodeURIComponent(rawKey.replace(/\+/g, ' '))] = decodeURIComponent(
        rawVal.replace(/\+/g, ' '),
      );
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

function getRawBody(req: FastifyRequest): Buffer | null {
  const raw = (req as FastifyRequest & { rawBody?: unknown }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
  return null;
}

// --- plugin ------------------------------------------------------------------

export const getCourseWebhookPlugin: FastifyPluginAsync<RegisterGetCourseWebhookOptions> = async (
  app,
  opts,
) => {
  const route = opts.route ?? '/webhook/getcourse';
  ensureRawBodyParser(app);

  app.post(route, async (req, reply) => {
    const raw = getRawBody(req);
    const contentType = (req.headers['content-type'] ?? null) as string | null;
    const ip = req.ip;

    // 1) HMAC статус (опциональный — null если не прислали).
    const sig =
      req.headers[GC_SIGNATURE_HEADER] ?? req.headers[GC_SIGNATURE_HEADER_LEGACY];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    const hmacValid = raw ? verifyHmac(raw, sigStr, opts.secret) : null;
    if (hmacValid === null && sigStr === undefined) {
      log.warn({ ip }, 'gc-webhook: no signature header — accepting anyway');
    } else if (hmacValid === false) {
      log.warn(
        { ip, hasHeader: Boolean(sigStr) },
        'gc-webhook: HMAC validation FAILED — saving event but mark as untrusted',
      );
    }

    // 2) payload — берём parsed (req.body) если есть, иначе пробуем raw.toString.
    let payload: unknown = req.body;
    if (payload === undefined || payload === null || payload === '') {
      payload = raw ? raw.toString('utf8') : null;
    }
    // jsonb не примет undefined/null; сохраним пустой объект если пусто.
    const payloadForDb = payload === null || payload === undefined ? {} : payload;

    // 3) headers — сохраняем все, для аудита.
    const safeHeaders: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      // Авторизационные значения — маскируем (можем подтянуть из raw event при необходимости).
      if (k === 'authorization' || k === 'x-api-key') {
        safeHeaders[k] = typeof v === 'string' ? `${v.slice(0, 12)}…(redacted)` : v;
      } else {
        safeHeaders[k] = v;
      }
    }

    // 4) INSERT raw event.
    try {
      const r = await opts.pool.query<{ id: string }>(
        `INSERT INTO getcourse_raw_events
            (raw_payload, headers, ip_address, hmac_valid, content_type, parse_status)
          VALUES ($1::jsonb, $2::jsonb, $3, $4, $5, 'pending')
          RETURNING id`,
        [
          JSON.stringify(payloadForDb),
          JSON.stringify(safeHeaders),
          ip,
          hmacValid,
          contentType,
        ],
      );
      log.info(
        { id: r.rows[0]?.id, hmacValid, contentType, ip },
        'gc-webhook: raw event saved (pending parse)',
      );
    } catch (err) {
      log.error({ err: (err as Error).message, ip }, 'gc-webhook: failed to insert raw event');
      // ВСЁ РАВНО возвращаем 200 — GC retry не нужен, событие потеряно (отдельный alert).
    }

    return reply.code(200).send({ status: 'received' });
  });

  log.info({ route }, 'gc-webhook: route registered (raw-events buffer)');
};
