// Клиент ChatPlace API. SPEC §2.10 (AC-27..AC-30) + §6.x (Integrations).
//
// ChatPlace — единственный способ управления Instagram-воронкой (см. CLAUDE.md §7
// "Воронки — только ChatPlace API"). Здесь — три ровно те функции, которые нужны
// Phase 4: послать DM подписчику, запустить именованный сценарий и найти
// подписчика по IG username.
//
// Эндпоинты ChatPlace в публичной документации отсутствуют, поэтому путь
// строится из конвенций (`/subscribers/dm`, `/scenarios/trigger`,
// `/subscribers?ig_username=`). При первом интеграционном тесте оператор
// должен сверить URL и при необходимости поправить CHATPLACE_API_BASE.
//
// Контракт:
//   - retry 3× с экспоненциальной задержкой на 429/5xx/network errors;
//   - Zod-валидация ответа;
//   - 4xx/5xx логируются как warn/error через pino (без секретов);
//   - DEV_DRY_RUN_CHATPLACE=true → возвращаем заглушку без сетевого вызова.

import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

// --- Zod-схемы ответов -------------------------------------------------------

// ChatPlace на каждый POST отвечает status'ом — фиксируем как required.
// Если в проде сервер вернёт без status, Zod-валидация развалится и мы пробросим
// схема-mismatch, что лучше тихого undefined (см. CLAUDE.md «никаких console.log/silent fail»).
const SendDirectMessageResponseSchema = z.object({
  status: z.enum(['queued', 'sent', 'failed']),
  message_id: z.string().optional(),
  error: z.string().optional(),
});
export type SendDirectMessageResponse = z.infer<typeof SendDirectMessageResponseSchema>;

const TriggerScenarioResponseSchema = z.object({
  status: z.enum(['triggered', 'queued', 'failed']),
  scenario_run_id: z.string().optional(),
  error: z.string().optional(),
});
export type TriggerScenarioResponse = z.infer<typeof TriggerScenarioResponseSchema>;

const ChatPlaceSubscriberSchema = z.object({
  id: z.string(),
  ig_username: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  subscribed_at: z.string().nullable().optional(),
});
export type ChatPlaceSubscriber = z.infer<typeof ChatPlaceSubscriberSchema>;

const GetSubscriberResponseSchema = z.object({
  subscriber: ChatPlaceSubscriberSchema.nullable(),
});

// --- HTTP-клиент -------------------------------------------------------------

export interface ChatPlaceHttpResponse {
  status: number;
  body: unknown;
}

export type ChatPlaceFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<ChatPlaceHttpResponse>;

const defaultFetch: ChatPlaceFetch = async (url, init) => {
  const init2: RequestInit = { method: init.method, headers: init.headers };
  if (init.body !== undefined) init2.body = init.body;
  const res = await fetch(url, init2);
  // Не падаем на не-JSON: возвращаем сырое тело.
  const ct = res.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body };
};

export interface ChatPlaceClientOptions {
  apiBase?: string;
  apiKey?: string;
  fetchImpl?: ChatPlaceFetch;
  /** Если true — не делаем сетевых вызовов, возвращаем стабильные заглушки. */
  dryRun?: boolean;
  maxAttempts?: number;
}

export interface ChatPlaceClient {
  sendDirectMessage(subscriberId: string, text: string): Promise<SendDirectMessageResponse>;
  triggerScenario(subscriberId: string, scenarioCode: string): Promise<TriggerScenarioResponse>;
  getSubscriberByIgUsername(username: string): Promise<ChatPlaceSubscriber | null>;
}

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 500;

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

async function request<T>(
  opts: Required<Pick<ChatPlaceClientOptions, 'apiBase' | 'maxAttempts'>> & {
    apiKey: string | undefined;
    fetchImpl: ChatPlaceFetch;
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
    schema: z.ZodType<T>;
    tag: string;
  },
): Promise<T> {
  const url = `${opts.apiBase.replace(/\/$/, '')}${opts.path}`;
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } = {
        method: opts.method,
        headers: buildHeaders(opts.apiKey),
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const res = await opts.fetchImpl(url, init);

      if (res.status >= 200 && res.status < 300) {
        const parsed = opts.schema.safeParse(res.body);
        if (!parsed.success) {
          log.error(
            { tag: opts.tag, status: res.status, issues: parsed.error.issues },
            'chatplace: response schema mismatch',
          );
          throw new Error(`chatplace ${opts.tag}: schema mismatch`);
        }
        return parsed.data;
      }

      // 4xx — клиентская ошибка, ретраить не имеет смысла (кроме 408/425/429).
      if (!RETRIABLE_STATUS.has(res.status)) {
        log.warn(
          { tag: opts.tag, status: res.status, url, attempt },
          'chatplace: non-retriable HTTP error',
        );
        throw new Error(`chatplace ${opts.tag}: HTTP ${res.status}`);
      }

      lastErr = new Error(`chatplace ${opts.tag}: HTTP ${res.status}`);
      log.warn(
        { tag: opts.tag, status: res.status, attempt, willRetry: attempt < opts.maxAttempts },
        'chatplace: retriable HTTP error',
      );
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message.startsWith('chatplace ')) {
        // Уже наша ошибка — если 4xx, пробрасываем сразу. Иначе ретраим.
        if (lastErr.message.includes('HTTP 4') && !lastErr.message.match(/HTTP (408|425|429)/)) {
          throw lastErr;
        }
      } else {
        log.warn(
          { tag: opts.tag, err: lastErr.message, attempt },
          'chatplace: network error',
        );
      }
    }

    if (attempt < opts.maxAttempts) {
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }

  throw lastErr ?? new Error(`chatplace ${opts.tag}: exhausted retries`);
}

export function createChatPlaceClient(opts: ChatPlaceClientOptions = {}): ChatPlaceClient {
  const apiBase = opts.apiBase ?? config.CHATPLACE_API_BASE;
  const apiKey = opts.apiKey ?? config.CHATPLACE_API_KEY;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const dryRun = opts.dryRun ?? config.DEV_DRY_RUN_CHATPLACE;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);

  return {
    async sendDirectMessage(subscriberId, text) {
      if (dryRun) {
        log.info({ subscriberId, len: text.length }, 'chatplace[dry-run]: sendDirectMessage');
        return { status: 'queued', message_id: `dryrun-${subscriberId}` };
      }
      return request({
        apiBase,
        apiKey,
        fetchImpl,
        maxAttempts,
        path: '/subscribers/dm',
        method: 'POST',
        body: { subscriber_id: subscriberId, text },
        schema: SendDirectMessageResponseSchema,
        tag: 'sendDirectMessage',
      });
    },

    async triggerScenario(subscriberId, scenarioCode) {
      if (dryRun) {
        log.info({ subscriberId, scenarioCode }, 'chatplace[dry-run]: triggerScenario');
        return { status: 'triggered', scenario_run_id: `dryrun-${subscriberId}` };
      }
      return request({
        apiBase,
        apiKey,
        fetchImpl,
        maxAttempts,
        path: '/scenarios/trigger',
        method: 'POST',
        body: { subscriber_id: subscriberId, scenario_code: scenarioCode },
        schema: TriggerScenarioResponseSchema,
        tag: 'triggerScenario',
      });
    },

    async getSubscriberByIgUsername(username) {
      if (dryRun) {
        log.info({ username }, 'chatplace[dry-run]: getSubscriberByIgUsername');
        return { id: `dryrun-${username}`, ig_username: username };
      }
      const r = await request({
        apiBase,
        apiKey,
        fetchImpl,
        maxAttempts,
        path: `/subscribers?ig_username=${encodeURIComponent(username)}`,
        method: 'GET',
        schema: GetSubscriberResponseSchema,
        tag: 'getSubscriberByIgUsername',
      });
      return r.subscriber;
    },
  };
}
