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
  IDEA: 'idea_queue',
  CONTENT: 'content_queue',
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
let _idea: Queue<IdeaJobData> | null = null;
let _content: Queue<ContentJobData> | null = null;

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

export function ideaQueue(): Queue<IdeaJobData> {
  if (!_idea) _idea = buildQueue<IdeaJobData>(QUEUE_NAMES.IDEA);
  return _idea;
}

export function contentQueue(): Queue<ContentJobData> {
  if (!_content) _content = buildQueue<ContentJobData>(QUEUE_NAMES.CONTENT);
  return _content;
}

export async function closeAllQueues(): Promise<void> {
  const all: Queue[] = [];
  if (_audio) all.push(_audio);
  if (_refDl) all.push(_refDl);
  if (_idea) all.push(_idea);
  if (_content) all.push(_content);
  await Promise.allSettled(all.map((q) => q.close()));
  _audio = null;
  _refDl = null;
  _idea = null;
  _content = null;
}
