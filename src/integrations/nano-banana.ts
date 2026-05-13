// Nano Banana Pro / Gemini 3 Pro Image — клиент генерации изображений.
//
// SPEC §5 (Google AI), AC-19. REST API без SDK (минимизируем зависимости).
// Endpoint: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//
// Идемпотентность не нужна (картинки уникальны), но retry с exponential backoff —
// обязателен (Google AI API даёт нестабильные ошибки на peak).

import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export interface GenerateImageInput {
  /** Промпт для рендера. */
  prompt: string;
  /** Сид для воспроизводимости (опционально). */
  seed?: number;
  /** Соотношение сторон. Default 9:16 (под Sharp кроп до 1080×1350 ≈ 4:5). */
  aspectRatio?: '1:1' | '4:5' | '9:16' | '16:9';
  /** Сколько кандидатов вернуть (Gemini API). */
  candidateCount?: number;
}

export interface GenerateImageOutput {
  /** Сырой PNG в Buffer (декодирован из base64). */
  png: Buffer;
  /** MIME из ответа Gemini. */
  mimeType: string;
  /** Сколько токенов потрачено (если API вернёт). */
  promptTokenCount?: number;
}

export interface NanoBananaDeps {
  fetchFn?: typeof fetch;
  /** Override base URL (для моков). */
  baseUrl?: string;
}

const InlineDataSchema = z.object({
  mimeType: z.string(),
  data: z.string().min(1),
});

const PartSchema = z.object({
  inlineData: InlineDataSchema.optional(),
  text: z.string().optional(),
});

const CandidateSchema = z.object({
  content: z.object({
    parts: z.array(PartSchema),
  }),
  finishReason: z.string().optional(),
});

const GeminiImageResponseSchema = z.object({
  candidates: z.array(CandidateSchema).min(1),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
    })
    .optional(),
});

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aspectDimensions(ar?: GenerateImageInput['aspectRatio']): { w: number; h: number } {
  switch (ar) {
    case '1:1':
      return { w: 1080, h: 1080 };
    case '16:9':
      return { w: 1920, h: 1080 };
    case '9:16':
      return { w: 1080, h: 1920 };
    case '4:5':
    default:
      return { w: 1080, h: 1350 };
  }
}

/** Рендерит изображение через Gemini 3 Pro Image. */
export async function generateImage(
  input: GenerateImageInput,
  deps: NanoBananaDeps = {},
): Promise<GenerateImageOutput> {
  // Placeholder mode — для smoke/dev в локациях, где Gemini API заблокирован геолокацией.
  if (config.NANO_BANANA_PLACEHOLDER_MODE) {
    const dims = aspectDimensions(input.aspectRatio);
    const png = await sharp({
      create: { width: dims.w, height: dims.h, channels: 3, background: { r: 240, g: 240, b: 240 } },
    })
      .png()
      .toBuffer();
    log.info({ bytes: png.length, mode: 'placeholder' }, 'nano-banana: placeholder PNG returned');
    return { png, mimeType: 'image/png' };
  }
  const apiKey = config.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('nano-banana: GEMINI_API_KEY is not set');
  }
  const model = config.GEMINI_IMAGE_MODEL;
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? DEFAULT_BASE_URL;
  const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ parts: [{ text: input.prompt }] }],
    generationConfig: {
      candidateCount: input.candidateCount ?? 1,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.aspectRatio
        ? { imageConfig: { aspectRatio: input.aspectRatio } }
        : {}),
    },
  };

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable body>');
        // 4xx — не ретраим, кроме 429
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`nano-banana: HTTP ${res.status} (no retry): ${text.slice(0, 200)}`);
        }
        throw new Error(`nano-banana: HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json: unknown = await res.json();
      const parsed = GeminiImageResponseSchema.parse(json);

      // EC-19: content policy refuse — не ретраим (бесполезно), эскалируем наверх.
      const finishReason = parsed.candidates[0]?.finishReason;
      if (
        finishReason === 'SAFETY' ||
        finishReason === 'PROHIBITED_CONTENT' ||
        finishReason === 'BLOCKLIST'
      ) {
        throw new Error(
          `nano-banana: content policy refused (finishReason=${finishReason}) (no retry)`,
        );
      }

      const inline = parsed.candidates[0]?.content.parts.find((p) => p.inlineData);
      if (!inline?.inlineData) {
        throw new Error('nano-banana: no inlineData in response');
      }
      const png = Buffer.from(inline.inlineData.data, 'base64');
      const result: GenerateImageOutput = {
        png,
        mimeType: inline.inlineData.mimeType,
      };
      if (parsed.usageMetadata?.promptTokenCount !== undefined) {
        result.promptTokenCount = parsed.usageMetadata.promptTokenCount;
      }
      log.info(
        {
          attempt,
          bytes: png.length,
          mimeType: inline.inlineData.mimeType,
          model,
        },
        'nano-banana: image generated',
      );
      return result;
    } catch (err) {
      lastError = err;
      const msg = (err as Error).message;
      const noRetry = /no retry/.test(msg);
      log.warn({ attempt, err: msg }, 'nano-banana: attempt failed');
      if (noRetry || attempt === MAX_RETRIES) break;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`nano-banana: failed after ${MAX_RETRIES} attempts`);
}
