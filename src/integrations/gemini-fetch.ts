// Общий fetch для Gemini API (nano-banana + gemini-video).
//
// Зачем: VPS Beget в РФ → Google AI блокирует по геолокации (FAILED_PRECONDITION).
// Решение: HTTPS-прокси из NL (proxy6.net и т.п.) через GEMINI_HTTPS_PROXY env.
//
// Прокси работает ТОЛЬКО для Gemini (Claude / OpenAI / Telegram / GetCourse — напрямую).
// Если GEMINI_HTTPS_PROXY пуст — fallback на обычный fetch (для локальной разработки
// или после переезда VPS в NL).
//
// Implementation: используем undici.ProxyAgent — нативный диспатчер для встроенного
// fetch в Node 22 (без лишней зависимости https-proxy-agent).

import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;

let cachedAgent: ProxyAgent | null = null;
let cachedProxyUrl: string | null = null;

function getProxyAgent(): ProxyAgent | null {
  const url = config.GEMINI_HTTPS_PROXY?.trim();
  if (!url) return null;
  if (cachedAgent && cachedProxyUrl === url) return cachedAgent;
  // undici.ProxyAgent с user:pass в URL не всегда корректно прокидывает Basic auth.
  // Разделяем URL и передаём token явно через Proxy-Authorization header.
  try {
    const u = new URL(url);
    const uri = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`;
    const hasAuth = u.username !== '' || u.password !== '';
    if (hasAuth) {
      const user = decodeURIComponent(u.username);
      const pass = decodeURIComponent(u.password);
      const token = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
      cachedAgent = new ProxyAgent({ uri, token });
    } else {
      cachedAgent = new ProxyAgent({ uri });
    }
    cachedProxyUrl = url;
    log.info({ host: safeProxyHost(url), withAuth: hasAuth }, 'gemini-fetch: ProxyAgent initialized');
    return cachedAgent;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'gemini-fetch: ProxyAgent init failed, falling back to direct');
    return null;
  }
}

function safeProxyHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return '<invalid>';
  }
}

export interface GeminiFetchOptions extends RequestInit {
  /** Кастомный таймаут (мс). Default 30000. */
  timeoutMs?: number;
}

/**
 * Делает fetch к Gemini API с опциональным HTTPS-прокси (через GEMINI_HTTPS_PROXY env)
 * и таймаутом по умолчанию 30 сек. При падении прокси — бросает понятную ошибку
 * с пометкой [gemini-proxy], чтобы в логах было видно.
 */
export async function geminiFetch(
  url: string,
  options: GeminiFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;
  const agent = getProxyAgent();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Используем undici.fetch (не global) — он принимает dispatcher.
  // Global fetch в Node 22 не пробрасывает dispatcher из RequestInit.
  const fetchOpts: Parameters<typeof undiciFetch>[1] = {
    ...(rest as unknown as Parameters<typeof undiciFetch>[1]),
    signal: controller.signal,
  };
  if (agent) (fetchOpts as { dispatcher?: ProxyAgent }).dispatcher = agent;

  try {
    return (await undiciFetch(url, fetchOpts)) as unknown as Response;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (agent) {
      throw new Error(`[gemini-proxy] fetch failed via proxy: ${msg}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** True если прокси настроен (для логов / диагностики). */
export function isGeminiProxyEnabled(): boolean {
  return Boolean(config.GEMINI_HTTPS_PROXY?.trim());
}
