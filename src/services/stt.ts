// STT-сервис: тонкая обёртка над Deepgram. Возвращает {text, confidence, language}.
// Если DEEPGRAM_API_KEY не задан — graceful fallback: возвращает status='unavailable',
// чтобы вызывающая сторона (BullMQ worker) могла отложить job в pending_jobs.

import { config } from '../config.js';
import { log } from '../observability/logger.js';
import {
  DeepgramClient,
  DeepgramError,
  type TranscribeResult,
} from '../integrations/deepgram.js';

export type SttInput =
  | { kind: 'url'; url: string; mimeType?: string }
  | { kind: 'buffer'; buffer: Buffer; mimeType: string };

export type SttResult =
  | { status: 'ok'; text: string; confidence: number; language: string; durationSec?: number; requestId?: string }
  | { status: 'unavailable'; reason: 'no_api_key' }
  | { status: 'error'; reason: string; statusCode?: number };

export interface SttServiceDeps {
  /** Допускает инъекцию клиента (для тестов). По умолчанию строится из config. */
  client?: DeepgramClient | null;
}

let lazyDefaultClient: DeepgramClient | null | undefined;

function getDefaultClient(): DeepgramClient | null {
  if (lazyDefaultClient !== undefined) return lazyDefaultClient;
  if (!config.DEEPGRAM_API_KEY) {
    lazyDefaultClient = null;
    return null;
  }
  lazyDefaultClient = new DeepgramClient({
    apiKey: config.DEEPGRAM_API_KEY,
    model: config.DEEPGRAM_MODEL,
    language: config.DEEPGRAM_LANGUAGE,
  });
  return lazyDefaultClient;
}

export async function transcribe(input: SttInput, deps: SttServiceDeps = {}): Promise<SttResult> {
  const client = deps.client === undefined ? getDefaultClient() : deps.client;
  if (!client) {
    log.warn('stt: DEEPGRAM_API_KEY missing — returning unavailable');
    return { status: 'unavailable', reason: 'no_api_key' };
  }
  try {
    const raw: TranscribeResult =
      input.kind === 'url'
        ? await client.transcribeUrl({
            url: input.url,
            ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
          })
        : await client.transcribeBuffer({ buffer: input.buffer, mimeType: input.mimeType });
    const result: SttResult = {
      status: 'ok',
      text: raw.text,
      confidence: raw.confidence,
      language: raw.language,
    };
    if (raw.durationSec !== undefined) result.durationSec = raw.durationSec;
    if (raw.requestId !== undefined) result.requestId = raw.requestId;
    return result;
  } catch (err) {
    if (err instanceof DeepgramError) {
      log.error({ err: err.message, status: err.statusCode }, 'stt: deepgram error');
      const result: SttResult = { status: 'error', reason: err.message };
      if (err.statusCode !== undefined) result.statusCode = err.statusCode;
      return result;
    }
    log.error({ err }, 'stt: unexpected error');
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason };
  }
}
