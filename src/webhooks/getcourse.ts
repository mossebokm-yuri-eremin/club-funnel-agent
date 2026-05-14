// GetCourse webhook — raw-events буфер с поддержкой GET и POST.
//
// АРХИТЕКТУРА (по решению Юрия 2026-05-14, после изучения доков GetCourse):
//   • GetCourse по умолчанию шлёт GET с query-string (НЕ POST с JSON).
//   • POST с JSON / x-www-form-urlencoded — тоже поддерживаем.
//   • Имена полей в payload — какие выставит подрядчик в админке.
//   • Мы ВСЕГДА отвечаем 200 OK с пустым body. GetCourse статус не парсит.
//   • Любой запрос → INSERT в getcourse_raw_events.
//   • Парсинг → getcourse-parser-worker (раз в 10 сек) → subscribers + Telegram notify.
//
// HMAC: ВРЕМЕННО отключён до подтверждения формата от подрядчика. Если заголовок
// X-GetCourse-Signature пришёл — пишем hmac_valid=true/false в БД, но не отказываем.
// Если не пришёл — hmac_valid=NULL.

import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { log } from '../observability/logger.js';

export const GC_SIGNATURE_HEADER = 'x-getcourse-signature';
export const GC_SIGNATURE_HEADER_LEGACY = 'x-gc-signature';

export interface RegisterGetCourseWebhookOptions {
  secret: string;
  pool: Pool;
  route?: string;
}

/** Возвращает true/false/null (null = заголовка нет). НЕ блокирует приём. */
export function verifyHmac(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean | null {
  if (!signatureHeader || !secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = signatureHeader.trim().toLowerCase();
  if (expected.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
  } catch {
    return false;
  }
}

// --- Body parsers ------------------------------------------------------------

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

// --- Plugin ------------------------------------------------------------------

export const getCourseWebhookPlugin: FastifyPluginAsync<RegisterGetCourseWebhookOptions> = async (
  app,
  opts,
) => {
  const route = opts.route ?? '/webhook/getcourse';
  ensureRawBodyParser(app);

  // Общий handler для GET и POST.
  const handleEvent = async (req: FastifyRequest, method: 'GET' | 'POST'): Promise<void> => {
    const contentType = (req.headers['content-type'] ?? null) as string | null;
    const ip = req.ip;
    const userAgent = (req.headers['user-agent'] ?? null) as string | null;
    const requestPath = req.url ?? route;

    // 1) query_params — для GET (основной канал) или для POST с query.
    const queryParams =
      typeof req.query === 'object' && req.query !== null
        ? (req.query as Record<string, unknown>)
        : null;

    // 2) body_raw + body_parsed — только для POST.
    const rawBuf = method === 'POST' ? getRawBody(req) : null;
    const bodyRaw = rawBuf ? rawBuf.toString('utf8') : null;
    const bodyParsed = method === 'POST' ? (req.body ?? null) : null;

    // 3) HMAC опционально (временно — до подтверждения формата от GC).
    const sig =
      req.headers[GC_SIGNATURE_HEADER] ?? req.headers[GC_SIGNATURE_HEADER_LEGACY];
    const sigStr = Array.isArray(sig) ? sig[0] : sig;
    const hmacValid = rawBuf ? verifyHmac(rawBuf, sigStr, opts.secret) : null;

    // 4) headers (с маской авторизации).
    const safeHeaders: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'authorization' || k === 'x-api-key' || k === 'cookie') {
        safeHeaders[k] = typeof v === 'string' ? `${v.slice(0, 12)}…(redacted)` : v;
      } else {
        safeHeaders[k] = v;
      }
    }

    // 5) INSERT raw event.
    try {
      const r = await opts.pool.query<{ id: string }>(
        `INSERT INTO getcourse_raw_events
            (request_method, request_path, query_params, body_raw, body_parsed,
             raw_payload, headers, ip_address, user_agent, hmac_valid, content_type, parse_status)
          VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, 'pending')
          RETURNING id`,
        [
          method,
          requestPath,
          queryParams ? JSON.stringify(queryParams) : null,
          bodyRaw,
          bodyParsed !== null && bodyParsed !== undefined ? JSON.stringify(bodyParsed) : null,
          // raw_payload (legacy NOT NULL — пишем то же что и body_parsed для совместимости с 006)
          JSON.stringify(bodyParsed ?? queryParams ?? {}),
          JSON.stringify(safeHeaders),
          ip,
          userAgent,
          hmacValid,
          contentType,
        ],
      );
      log.info(
        {
          id: r.rows[0]?.id,
          method,
          contentType,
          hmacValid,
          ip,
          hasQuery: queryParams ? Object.keys(queryParams).length : 0,
          hasBody: bodyRaw ? bodyRaw.length : 0,
        },
        'gc-webhook: raw event saved',
      );
    } catch (err) {
      log.error(
        { err: (err as Error).message, method, ip },
        'gc-webhook: failed to insert raw event',
      );
    }
  };

  app.get(route, async (req, reply) => {
    await handleEvent(req, 'GET');
    return reply.code(200).send();
  });

  app.post(route, async (req, reply) => {
    await handleEvent(req, 'POST');
    return reply.code(200).send();
  });

  log.info({ route }, 'gc-webhook: route registered (GET+POST raw-events buffer)');
};
