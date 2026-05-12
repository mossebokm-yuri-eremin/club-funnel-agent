// yt-dlp + RapidAPI Instagram Downloader (SPEC AC-39).
//
// Цепочка: yt-dlp (primary, child_process) → ошибка → RapidAPI fallback → ошибка → throw
// (caller ставит references_inbox.download_status='failed' и просит Юрия скинуть файл).
//
// На VPS yt-dlp устанавливается через `pip3 install --break-system-packages -U yt-dlp`
// (см. scripts/deploy.sh шаг 6).

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export type DownloadProvider = 'yt-dlp' | 'rapidapi';

export interface DownloadInput {
  /** Публичный URL Instagram-поста / Reel'а / карусели. */
  url: string;
  /** Куда сохранить файл. Например /var/lib/ytdlp/ref-{ref_id}.mp4 */
  outPath: string;
}

export interface DownloadOutput {
  provider: DownloadProvider;
  localPath: string;
  bytes: number;
  durationSec?: number;
}

export interface YtdlpDeps {
  /** Кастомный путь к бинарю yt-dlp (для тестов). По умолчанию из PATH. */
  ytdlpBin?: string;
  /** Override для тестов. */
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  writeFile?: typeof fs.writeFile;
  stat?: typeof fs.stat;
  mkdir?: typeof fs.mkdir;
}

const RapidApiIgSchema = z.object({
  // Гибкая схема: разные RapidAPI Instagram Downloader возвращают разные структуры.
  // Минимум — где-то должен быть прямой URL до mp4 / jpg.
  download_url: z.string().url().optional(),
  video_url: z.string().url().optional(),
  url: z.string().url().optional(),
  media: z.array(z.object({ url: z.string().url() })).optional(),
});

function ensureDirOf(filePath: string, mkdir: typeof fs.mkdir): Promise<void> {
  return mkdir(path.dirname(filePath), { recursive: true }).then(() => undefined);
}

async function tryYtdlp(input: DownloadInput, deps: YtdlpDeps): Promise<DownloadOutput> {
  const bin = deps.ytdlpBin ?? 'yt-dlp';
  const spawnFn = deps.spawnFn ?? spawn;
  const stat = deps.stat ?? fs.stat;
  const mkdir = deps.mkdir ?? fs.mkdir;

  await ensureDirOf(input.outPath, mkdir);

  // -f mp4 — приоритет mp4; --no-playlist на всякий случай; --no-warnings — тише в логах.
  const args = [input.url, '-o', input.outPath, '--no-playlist', '-f', 'mp4', '--no-warnings'];
  log.info({ url: input.url, outPath: input.outPath, bin }, 'ytdlp: spawn');

  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const errChunks: Buffer[] = [];
    child.stderr?.on('data', (c: Buffer) => errChunks.push(c));
    child.on('error', (err) => reject(err));
    child.on('close', (code: number | null) => {
      if (code === 0) return resolve();
      const stderr = Buffer.concat(errChunks).toString('utf8').slice(-500);
      reject(new Error(`yt-dlp exit ${code}: ${stderr}`));
    });
  });

  const st = await stat(input.outPath);
  if (!st.size) {
    throw new Error('yt-dlp: empty file written');
  }
  return { provider: 'yt-dlp', localPath: input.outPath, bytes: st.size };
}

async function tryRapidApi(input: DownloadInput, deps: YtdlpDeps): Promise<DownloadOutput> {
  const apiKey = config.RAPIDAPI_KEY;
  if (!apiKey) throw new Error('rapidapi: RAPIDAPI_KEY not set');
  const fetchFn = deps.fetchFn ?? fetch;
  const writeFile = deps.writeFile ?? fs.writeFile;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const stat = deps.stat ?? fs.stat;

  const host = config.RAPIDAPI_IG_HOST;
  // Используем GET с query-параметром url, типовое API для Instagram Downloader.
  const apiUrl = `https://${host}/?url=${encodeURIComponent(input.url)}`;
  log.info({ host, url: input.url }, 'rapidapi: fetching metadata');

  const res = await fetchFn(apiUrl, {
    method: 'GET',
    headers: {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': host,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`rapidapi: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const json: unknown = await res.json();
  const parsed = RapidApiIgSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`rapidapi: schema mismatch: ${parsed.error.message}`);
  }
  const mediaUrl =
    parsed.data.download_url ??
    parsed.data.video_url ??
    parsed.data.url ??
    parsed.data.media?.[0]?.url;
  if (!mediaUrl) throw new Error('rapidapi: no media URL in response');

  // Скачиваем медиафайл напрямую.
  const mediaRes = await fetchFn(mediaUrl);
  if (!mediaRes.ok) {
    throw new Error(`rapidapi: media fetch HTTP ${mediaRes.status}`);
  }
  const buf = Buffer.from(await mediaRes.arrayBuffer());
  await ensureDirOf(input.outPath, mkdir);
  await writeFile(input.outPath, buf);
  const st = await stat(input.outPath);
  return { provider: 'rapidapi', localPath: input.outPath, bytes: st.size };
}

export async function downloadInstagram(
  input: DownloadInput,
  deps: YtdlpDeps = {},
): Promise<DownloadOutput> {
  // 1) yt-dlp primary.
  try {
    return await tryYtdlp(input, deps);
  } catch (err) {
    log.warn(
      { url: input.url, err: (err as Error).message },
      'ytdlp: failed, falling back to RapidAPI',
    );
  }
  // 2) RapidAPI fallback.
  return tryRapidApi(input, deps);
}
