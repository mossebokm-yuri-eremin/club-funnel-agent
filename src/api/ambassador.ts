// Ambassador API — endpoint для проекта ye-ambassador-bot.
// GET /api/ambassador/purchases?since=<ISO>  Bearer <AMBASSADOR_API_TOKEN>
// Возвращает все оплаты клуба с utm_source='ambassador' с paid_at > since.
//
// Auth: timingSafeEqual против config.AMBASSADOR_API_TOKEN (НЕ ==).
// Фильтр клуба: utm_source='ambassador' + offer_name ILIKE '%реализация%'
//               ИЛИ raw_payload->>'offer_id'='2474615' (на случай если ТЗ имел в виду
//               offer_id, а не process_id).
// Сортировка: paid_at ASC, LIMIT 100.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

function isAuthorized(headerValue: string | undefined): boolean {
  const expected = config.AMBASSADOR_API_TOKEN ?? '';
  if (!expected) return false;
  if (!headerValue) return false;
  const m = /^Bearer\s+(.+)$/.exec(headerValue.trim());
  if (!m) return false;
  const got = m[1] ?? '';
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

interface PurchaseRow {
  subscriber_id: string;
  email: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  paid_at: Date;
  amount_kopecks: string | number;
}

export async function registerAmbassadorRoutes(
  app: FastifyInstance,
  pool: Pool,
): Promise<void> {
  app.get<{ Querystring: { since?: string } }>('/api/ambassador/purchases', async (req, reply) => {
    const auth = (req.headers['authorization'] ?? '') as string;
    if (!isAuthorized(auth)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const sinceRaw = req.query.since;
    let since: Date;
    if (!sinceRaw) {
      since = new Date('1970-01-01T00:00:00Z');
    } else {
      const parsed = new Date(sinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        reply.code(400);
        return { error: 'invalid since' };
      }
      since = parsed;
    }

    const r = await pool.query<PurchaseRow>(
      `SELECT
         p.subscriber_id::text                       AS subscriber_id,
         s.email                                      AS email,
         p.utm_campaign                               AS utm_campaign,
         (p.raw_payload->>'utm_content')              AS utm_content,
         p.paid_at                                    AS paid_at,
         p.amount_kopecks                             AS amount_kopecks
       FROM payments p
       JOIN subscribers s ON s.id = p.subscriber_id
       WHERE p.utm_source = 'ambassador'
         AND p.paid_at > $1
         AND s.deleted_at IS NULL
         AND (
           (p.raw_payload->>'offer_name') ILIKE '%реализация%'
           OR (p.raw_payload->>'offer_id') = '2474615'
         )
       ORDER BY p.paid_at ASC
       LIMIT 100`,
      [since.toISOString()],
    );

    const purchases = r.rows.map((row) => ({
      subscriber_id: row.subscriber_id,
      email: row.email,
      utm_campaign: row.utm_campaign,
      utm_content: row.utm_content,
      paid_at: new Date(row.paid_at).toISOString(),
      amount_kopecks: Number(row.amount_kopecks),
    }));

    log.info(
      { since: since.toISOString(), count: purchases.length },
      'ambassador-api: purchases fetched',
    );
    return { purchases };
  });
}
