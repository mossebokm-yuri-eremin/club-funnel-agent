// Очереди BullMQ. SPEC §3.5 — таблица очередей.
// Здесь — те, что нужны Фазе 2: `audio_queue` (STT), `reference_dl_queue`
// (загрузка IG, пока без yt-dlp — только enqueue), и `idea_queue` (для последующих фаз).
//
// ВАЖНО: воркеры не запускаются автоматически при импорте этого модуля.
// Вызывайте createWorkers() из bootstrap-кода (src/index.ts).

import { Queue, type QueueOptions, type JobsOptions } from 'bullmq';
import { createRedisClient } from '../redis.js';
import { log } from '../observability/logger.js';

export const QUEUE_NAMES = {
  AUDIO: 'audio_queue',
  REFERENCE_DL: 'reference_dl_queue',
  REFERENCE_PROCESS: 'reference_process_queue',
  IDEA: 'idea_queue',
  CONTENT: 'content_queue',
  VISUAL: 'visual_queue',
  FUNNEL: 'funnel_queue',
  GETCOURSE_PULL: 'getcourse_pull_queue',
  GETCOURSE_PARSE: 'getcourse_parse_queue',
  WARMUP: 'warmup_queue',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// --- Типы payload'ов ---

export interface SttJobData {
  /** Telegram file_id или прямой URL */
  source: { kind: 'tg_file'; fileId: string } | { kind: 'url'; url: string };
  /** Кто прислал (tg_user_id) — для аудита 152-ФЗ */
  tg_user_id: number;
  /** Идентификатор сообщения (для idempotency) */
  message_id: number;
  /** mime-type, если знаем */
  mime_type?: string;
  /** Длительность голосового в секундах */
  duration_sec?: number;
  /** Откуда: voice | audio | document */
  origin: 'voice' | 'audio' | 'document';
}

export interface ReferenceDetectJobData {
  tg_user_id: number;
  message_id: number;
  detection: {
    source: string;
    confidence: number;
    mediaUrl?: string;
    captionText?: string;
  };
  /** TG file_id видеосообщения (если есть) */
  video_file_id?: string;
  photo_file_ids?: string[];
}

export interface IdeaJobData {
  idea_id: string;
}

export interface ContentJobData {
  idea_id: string;
  /** Уже выбранная стратегия — если null, content-worker сам её посчитает. */
  strategy?: 'A' | 'B' | 'C';
  forced_bonus_id?: string;
}

export type FunnelJobData =
  | {
      kind: 'longread_delivery';
      subscriber_id: string;
      bonus_id: string;
      funnel_id?: string;
      code_word?: string;
      chatplace_subscriber_id?: string;
    }
  | {
      kind: 'club_upsell';
      subscriber_id: string;
      funnel_id?: string;
      code_word?: string;
      chatplace_subscriber_id?: string;
    };

export interface GetCoursePullJobData {
  /** Тип pull-а: 'subscribers' тянет общий список, 'order' проверяет одиночный orderId. */
  kind: 'subscribers' | 'order';
  order_id?: string;
}

export interface ReferenceProcessJobData {
  /** UUID строки в references_inbox (созданной reference-detect-worker). */
  reference_id: string;
  /** Публичный URL Instagram-поста / Reel'а. */
  source_url: string;
  /** Тип медиа — влияет на промпт Gemini. */
  source_type: 'reel' | 'carousel' | 'post' | 'video_file';
}

export interface VisualJobData {
  /** Идея, под которую рендерим карусель. */
  idea_id: string;
  /** ID content_package — обновим в нём поле assets с URL'ами. */
  content_package_id: string;
  /** Подсказка стиля от Юрия (опционально). */
  style_hint?: string;
}

// --- Дефолтные опции ---

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

function buildQueue<T>(name: QueueName, jobOptions: JobsOptions = DEFAULT_JOB_OPTIONS): Queue<T> {
  const opts: QueueOptions = {
    connection: createRedisClient(),
    defaultJobOptions: jobOptions,
  };
  const q = new Queue<T>(name, opts);
  q.on('error', (err) => {
    log.error({ err, queue: name }, 'bullmq queue error');
  });
  return q;
}

// Lazy-инициализация: создаём при первом обращении, чтобы тесты,
// которые не используют очереди, не открывали Redis-коннект.
let _audio: Queue<SttJobData> | null = null;
let _refDl: Queue<ReferenceDetectJobData> | null = null;
let _refProc: Queue<ReferenceProcessJobData> | null = null;
let _idea: Queue<IdeaJobData> | null = null;
let _content: Queue<ContentJobData> | null = null;
let _visual: Queue<VisualJobData> | null = null;
let _funnel: Queue<FunnelJobData> | null = null;
let _gcPull: Queue<GetCoursePullJobData> | null = null;

export function audioQueue(): Queue<SttJobData> {
  if (!_audio) _audio = buildQueue<SttJobData>(QUEUE_NAMES.AUDIO);
  return _audio;
}

export function referenceDlQueue(): Queue<ReferenceDetectJobData> {
  if (!_refDl) {
    _refDl = buildQueue<ReferenceDetectJobData>(QUEUE_NAMES.REFERENCE_DL, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5, // SPEC §3.5: 5× (yt-dlp→RapidAPI→manual)
    });
  }
  return _refDl;
}

export function referenceProcessQueue(): Queue<ReferenceProcessJobData> {
  if (!_refProc) {
    _refProc = buildQueue<ReferenceProcessJobData>(QUEUE_NAMES.REFERENCE_PROCESS, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5, // SPEC §3.5: 5× (yt-dlp→RapidAPI→manual)
      backoff: { type: 'exponential', delay: 10_000 },
    });
  }
  return _refProc;
}

export function ideaQueue(): Queue<IdeaJobData> {
  if (!_idea) _idea = buildQueue<IdeaJobData>(QUEUE_NAMES.IDEA);
  return _idea;
}

export function contentQueue(): Queue<ContentJobData> {
  if (!_content) _content = buildQueue<ContentJobData>(QUEUE_NAMES.CONTENT);
  return _content;
}

export function visualQueue(): Queue<VisualJobData> {
  if (!_visual) {
    _visual = buildQueue<VisualJobData>(QUEUE_NAMES.VISUAL, {
      ...DEFAULT_JOB_OPTIONS,
      // Nano Banana бывает нестабильным — больше попыток + длиннее backoff.
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
    });
  }
  return _visual;
}

export function funnelQueue(): Queue<FunnelJobData> {
  if (!_funnel) {
    _funnel = buildQueue<FunnelJobData>(QUEUE_NAMES.FUNNEL, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 5,
    });
  }
  return _funnel;
}

export function getCoursePullQueue(): Queue<GetCoursePullJobData> {
  if (!_gcPull) {
    _gcPull = buildQueue<GetCoursePullJobData>(QUEUE_NAMES.GETCOURSE_PULL, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 3,
      // Hourly pull — лёгкие задачи, чистим быстрее.
      removeOnComplete: { age: 24 * 3600, count: 200 },
    });
  }
  return _gcPull;
}

let _gcParse: Queue<Record<string, never>> | null = null;
export function getCourseParseQueue(): Queue<Record<string, never>> {
  if (!_gcParse) {
    _gcParse = buildQueue<Record<string, never>>(QUEUE_NAMES.GETCOURSE_PARSE, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 1, // не ретраить — следующая итерация cron подберёт снова
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600, count: 50 },
    });
  }
  return _gcParse;
}

let _warmup: Queue<Record<string, never>> | null = null;
export function warmupQueue(): Queue<Record<string, never>> {
  if (!_warmup) {
    _warmup = buildQueue<Record<string, never>>(QUEUE_NAMES.WARMUP, {
      ...DEFAULT_JOB_OPTIONS,
      attempts: 1,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600, count: 50 },
    });
  }
  return _warmup;
}

export async function closeAllQueues(): Promise<void> {
  const all: Queue[] = [];
  if (_audio) all.push(_audio);
  if (_refDl) all.push(_refDl);
  if (_refProc) all.push(_refProc);
  if (_idea) all.push(_idea);
  if (_content) all.push(_content);
  if (_visual) all.push(_visual);
  if (_funnel) all.push(_funnel);
  if (_gcPull) all.push(_gcPull);
  if (_gcParse) all.push(_gcParse);
  if (_warmup) all.push(_warmup);
  await Promise.allSettled(all.map((q) => q.close()));
  _audio = null;
  _refDl = null;
  _refProc = null;
  _idea = null;
  _content = null;
  _visual = null;
  _funnel = null;
  _gcPull = null;
  _gcParse = null;
  _warmup = null;
}
