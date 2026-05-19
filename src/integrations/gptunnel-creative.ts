// GPTunnel Creative Lab — российский агрегатор моделей генерации изображений.
// Используем seedream-4 (ByteDance, 4K, ~8₽/картинка) как основной AI-провайдер
// после того как Gemini оказался заблокирован геолокацией РФ.
//
// Endpoint:  POST https://gptunnel.ru/v1/media/generate
// Auth:      Authorization: <token>  (чисто токен, БЕЗ префикса 'Bearer')
// Response:  result = URL (живёт 24h — надо скачать сразу), cost (рубли),
//            id (generation id).
//
// Seedream плохо умеет кириллицу — текст НЕ передаём в prompt,
// Sharp накладывает текст поверх готовой картинки (см. carousel-renderer).

// Используем встроенный Node 22 fetch (без undici-deps).
// GPTunnel в РФ — прокси не нужен, dispatcher тоже.
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export type GptunnelModel = 'seedream-4' | 'flux-ultra' | 'imagine-3';
export type GptunnelAspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '21:9' | '9:21';
export type GptunnelSize = '1K' | '2K' | '3K' | '4K';

export interface GenerateImageInput {
  /** Промпт визуальной концепции (без текста слайда; seedream плохо умеет кириллицу). */
  prompt: string;
  model?: GptunnelModel;
  aspectRatio?: GptunnelAspectRatio;
  size?: GptunnelSize;
  /** URL/base64 референсов для style transfer. */
  referenceImages?: string[];
}

export interface GenerateImageOutput {
  /** URL картинки на стороне GPTunnel — действителен ~24 часа. Надо скачать сразу. */
  imageUrl: string;
  /** Стоимость в рублях (parseFloat от response.cost). */
  costRub: number;
  /** Стоимость в копейках (для INSERT в image_generations — CLAUDE.md §4 sacred). */
  costKopecks: number;
  /** id у GPTunnel (для логов / billing reconciliation). */
  generationId: string;
  /** Сколько по часам шла генерация. */
  durationMs: number;
  /** Сама модель, которая отработала (если GPTunnel сделал fallback). */
  modelUsed: string;
}

const BASE_URL = 'https://gptunnel.ru/v1/media';
const DEFAULT_MODEL: GptunnelModel = 'seedream-4';
const DEFAULT_ASPECT: GptunnelAspectRatio = '9:16';
const DEFAULT_SIZE: GptunnelSize = '2K';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 120_000;

interface GptunnelGenerateResponse {
  id?: string;
  result?: string;
  cost?: string | number;
  model?: string;
  error?: string;
  message?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rublesToKopecks(rub: number): number {
  if (!Number.isFinite(rub)) return 0;
  return Math.round(rub * 100);
}

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Генерирует одну картинку через GPTunnel Creative Lab.
 * Retry x3 с экспоненциальной задержкой на 429/5xx/network.
 * 4xx (кроме 429) — без ретрая.
 */
export async function generateGptunnelImage(
  input: GenerateImageInput,
): Promise<GenerateImageOutput> {
  const apiKey = config.GPTUNNEL_API_KEY;
  if (!apiKey) throw new Error('gptunnel: GPTUNNEL_API_KEY not set in env');

  const model = input.model ?? DEFAULT_MODEL;
  const aspect = input.aspectRatio ?? DEFAULT_ASPECT;
  const size = input.size ?? DEFAULT_SIZE;

  const body: Record<string, unknown> = {
    model,
    prompt: input.prompt,
    aspect_ratio: aspect,
    size,
    response_format: 'url',
  };
  if (input.referenceImages && input.referenceImages.length > 0) {
    body.images = input.referenceImages;
  }

  const startedAt = Date.now();
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}/generate`, {
        method: 'POST',
        headers: {
          // ВАЖНО: GPTunnel требует чистый токен, БЕЗ префикса 'Bearer'.
          Authorization: apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const isRetriable = isRetriableStatus(res.status);
        const errMsg = `gptunnel HTTP ${res.status}: ${text.slice(0, 200)}`;
        log.warn(
          { attempt, status: res.status, retriable: isRetriable, prompt: input.prompt.slice(0, 60) },
          'gptunnel: non-2xx response',
        );
        if (!isRetriable || attempt === MAX_RETRIES) {
          throw new Error(errMsg);
        }
        await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      const json = (await res.json()) as GptunnelGenerateResponse;
      if (!json.result) {
        throw new Error(
          `gptunnel: response missing 'result' URL — payload: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }
      const costRubRaw = json.cost;
      const costRub =
        typeof costRubRaw === 'number'
          ? costRubRaw
          : typeof costRubRaw === 'string'
            ? parseFloat(costRubRaw)
            : 0;
      const durationMs = Date.now() - startedAt;
      log.info(
        {
          model,
          aspect,
          size,
          costRub,
          durationMs,
          generationId: json.id,
          promptPreview: input.prompt.slice(0, 80),
        },
        'gptunnel: image generated',
      );
      return {
        imageUrl: json.result,
        costRub,
        costKopecks: rublesToKopecks(costRub),
        generationId: json.id ?? '',
        durationMs,
        modelUsed: json.model ?? model,
      };
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message;
      // Network/abort/timeout — ретрай в пределах лимита.
      if (msg.includes('aborted') || msg.includes('fetch failed') || msg.includes('ECONN')) {
        log.warn({ attempt, err: msg }, 'gptunnel: network error, will retry');
        if (attempt < MAX_RETRIES) {
          await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
      }
      // Прочие ошибки (включая non-retriable HTTP из ветки выше) — прокидываем.
      throw lastErr;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`gptunnel: exhausted ${MAX_RETRIES} retries`);
}

/** Скачивает картинку по URL (Seedream живёт 24h — надо забрать сразу после generateImage). */
export async function downloadGptunnelImage(imageUrl: string): Promise<Buffer> {
  const startedAt = Date.now();
  const res = await fetch(imageUrl, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`gptunnel download HTTP ${res.status}: ${imageUrl.slice(0, 80)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  log.debug(
    { url: imageUrl.slice(0, 80), bytes: buf.length, durationMs: Date.now() - startedAt },
    'gptunnel: image downloaded',
  );
  return buf;
}
