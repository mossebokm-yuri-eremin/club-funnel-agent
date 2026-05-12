// Клиент GetCourse: hourly pull для сверки subscribers + статус ордеров.
//
// Контракт (CLAUDE.md §6 «Платежи — только GetCourse»):
//   - HMAC verify живёт в src/webhooks/getcourse.ts, здесь не дублируем.
//   - Этот файл — только pull-операции и lookup ордера для reconcile (SPEC §6.2,
//     CRON_GC_RECONCILE='0 * * * *').
//   - Zod-валидация для всего, что приходит снаружи.
//   - 4xx/5xx → структурный лог через pino, без секретов.
//   - DEV_DRY_RUN_GETCOURSE → возвращаем заглушку и пишем info.
//
// Реальный GetCourse REST формат непостоянен; здесь — общая структура «list →
// success/items» с ключевыми полями оператора. Если у YE другая привязка —
// поменяйте Zod-схему и path в одном месте.

import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

// --- Zod-схемы ---------------------------------------------------------------

export const GcSubscriberSchema = z.object({
  id: z.coerce.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  status: z.string().optional(),
  subscribed_at: z.string().optional(),
  groups: z.array(z.string()).optional(),
});
export type GcSubscriber = z.infer<typeof GcSubscriberSchema>;

export const GcOrderSchema = z.object({
  id: z.coerce.string(),
  offer_id: z.coerce.string().optional(),
  status: z.string(),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  user_email: z.string().nullable().optional(),
  paid_at: z.string().nullable().optional(),
  utm: z.record(z.string(), z.string()).optional(),
});
export type GcOrder = z.infer<typeof GcOrderSchema>;

const ListResponseSchema = z.object({
  success: z.boolean().optional(),
  items: z.array(z.unknown()),
  next_page: z.string().nullable().optional(),
});

const OrderResponseSchema = z.object({
  success: z.boolean().optional(),
  order: GcOrderSchema.nullable(),
});

// --- HTTP-клиент -------------------------------------------------------------

export interface GcHttpResponse {
  status: number;
  body: unknown;
}

export type GcFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<GcHttpResponse>;

const defaultFetch: GcFetch = async (url, init) => {
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body };
};

export interface GcClientOptions {
  apiBase?: string;
  apiKey?: string;
  fetchImpl?: GcFetch;
  dryRun?: boolean;
  maxAttempts?: number;
}

export interface GcClient {
  hourlyPullSubscribers(opts?: { groupContains?: string }): Promise<GcSubscriber[]>;
  getOrderStatus(orderId: string): Promise<GcOrder | null>;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 500;
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (apiKey) h['x-api-key'] = apiKey;
  return h;
}

async function get<T>(
  opts: Required<Pick<GcClientOptions, 'apiBase' | 'maxAttempts'>> & {
    apiKey: string | undefined;
    fetchImpl: GcFetch;
    path: string;
    tag: string;
    schema: z.ZodType<T>;
  },
): Promise<T> {
  const url = `${opts.apiBase.replace(/\/$/, '')}${opts.path}`;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const res = await opts.fetchImpl(url, { method: 'GET', headers: buildHeaders(opts.apiKey) });

      if (res.status >= 200 && res.status < 300) {
        const parsed = opts.schema.safeParse(res.body);
        if (!parsed.success) {
          log.error(
            { tag: opts.tag, issues: parsed.error.issues, status: res.status },
            'getcourse: response schema mismatch',
          );
          throw new Error(`getcourse ${opts.tag}: schema mismatch`);
        }
        return parsed.data;
      }

      if (!RETRIABLE_STATUS.has(res.status)) {
        log.warn({ tag: opts.tag, status: res.status, attempt }, 'getcourse: non-retriable error');
        throw new Error(`getcourse ${opts.tag}: HTTP ${res.status}`);
      }
      lastErr = new Error(`getcourse ${opts.tag}: HTTP ${res.status}`);
      log.warn(
        { tag: opts.tag, status: res.status, attempt, willRetry: attempt < opts.maxAttempts },
        'getcourse: retriable HTTP error',
      );
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message.includes('schema mismatch')) throw lastErr;
      if (lastErr.message.match(/HTTP 4(?!08|25|29)/)) throw lastErr;
      log.warn({ tag: opts.tag, err: lastErr.message, attempt }, 'getcourse: network error');
    }
    if (attempt < opts.maxAttempts) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }
  throw lastErr ?? new Error(`getcourse ${opts.tag}: retries exhausted`);
}

export function createGetCourseClient(opts: GcClientOptions = {}): GcClient {
  const apiBase = opts.apiBase ?? config.GC_API_BASE;
  const apiKey = opts.apiKey ?? config.GC_API_KEY;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const dryRun = opts.dryRun ?? config.DEV_DRY_RUN_GETCOURSE;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const pageSize = config.GC_PULL_PAGE_SIZE;

  return {
    async hourlyPullSubscribers(callOpts) {
      if (dryRun) {
        log.info({ pageSize }, 'getcourse[dry-run]: hourlyPullSubscribers');
        return [];
      }
      const out: GcSubscriber[] = [];
      let cursor: string | null = null;
      // Жёсткий cap: не более 50 страниц за один pull, чтобы не повесить crontab.
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ limit: String(pageSize) });
        if (cursor) qs.set('page', cursor);
        if (callOpts?.groupContains) qs.set('group', callOpts.groupContains);
        const r = await get({
          apiBase,
          apiKey,
          fetchImpl,
          maxAttempts,
          path: `/subscribers?${qs.toString()}`,
          tag: 'hourlyPullSubscribers',
          schema: ListResponseSchema,
        });
        for (const raw of r.items) {
          const parsed = GcSubscriberSchema.safeParse(raw);
          if (parsed.success) out.push(parsed.data);
          else {
            log.warn(
              { issues: parsed.error.issues.slice(0, 3) },
              'getcourse: subscriber item failed schema, skipping',
            );
          }
        }
        if (!r.next_page) break;
        cursor = r.next_page;
      }
      log.info({ count: out.length }, 'getcourse: hourly pull complete');
      return out;
    },

    async getOrderStatus(orderId) {
      if (dryRun) {
        log.info({ orderId }, 'getcourse[dry-run]: getOrderStatus');
        return null;
      }
      const r = await get({
        apiBase,
        apiKey,
        fetchImpl,
        maxAttempts,
        path: `/orders/${encodeURIComponent(orderId)}`,
        tag: 'getOrderStatus',
        schema: OrderResponseSchema,
      });
      return r.order;
    },
  };
}
