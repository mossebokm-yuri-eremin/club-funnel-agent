// Cloudinary uploader для каруселей (SPEC AC-21).
//
// Использует официальный SDK (cloudinary v2). Конфиг — из ENV. Folder по умолчанию
// `club-funnel/{ideaId}/`. Fallback: если Cloudinary недоступен > 30 сек, пишем PNG
// локально в CLOUDINARY_FALLBACK_LOCAL_DIR (на VPS — /var/www/cdn под публичным nginx).

import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export interface CloudinaryUploadInput {
  /** JPG в Buffer (SPEC AC-21 — «Готовые JPG»). */
  jpg: Buffer;
  /** Идея, к которой относится изображение. */
  ideaId: string;
  /** Порядковый номер слайда (1..N). Используется в public_id. */
  slideIndex: number;
  /** Тип артефакта: для каруселей всегда 'carousel', но оставим расширяемым. */
  artifact?: 'carousel' | 'reel' | 'longread_cover';
}

export interface CloudinaryUploadOutput {
  /** Финальный публичный URL картинки. */
  url: string;
  /** Источник: cloudinary | local (fallback). */
  source: 'cloudinary' | 'local';
  /** Public ID в Cloudinary (если cloud), либо относительный путь (если local). */
  publicId: string;
  /** Время загрузки в мс. */
  durationMs: number;
}

export interface CloudinaryDeps {
  /** Уже сконфигурированный uploader (для тестов). */
  uploader?: typeof cloudinary.uploader;
  /** Override fs (для тестов). */
  writeFile?: typeof fs.writeFile;
  /** Override mkdir (для тестов). */
  mkdir?: typeof fs.mkdir;
  /** Timeout в мс перед fallback на local. По умолчанию 30 сек (SPEC AC-21). */
  timeoutMs?: number;
}

let _cloudinaryConfigured = false;

function configureCloudinaryOnce(): void {
  if (_cloudinaryConfigured) return;
  if (!config.CLOUDINARY_CLOUD_NAME || !config.CLOUDINARY_API_KEY || !config.CLOUDINARY_API_SECRET) {
    log.warn({}, 'cloudinary: env not set, will fallback to local');
    return;
  }
  cloudinary.config({
    cloud_name: config.CLOUDINARY_CLOUD_NAME,
    api_key: config.CLOUDINARY_API_KEY,
    api_secret: config.CLOUDINARY_API_SECRET,
    secure: true,
  });
  _cloudinaryConfigured = true;
}

function buildPublicId(input: CloudinaryUploadInput): string {
  const artifact = input.artifact ?? 'carousel';
  return `${input.ideaId}/${artifact}-${String(input.slideIndex).padStart(2, '0')}`;
}

function buildFolder(input: CloudinaryUploadInput): string {
  return `${config.CLOUDINARY_UPLOAD_FOLDER}/${input.ideaId}`;
}

async function uploadToCloudinary(
  input: CloudinaryUploadInput,
  uploader: typeof cloudinary.uploader,
  timeoutMs: number,
): Promise<UploadApiResponse> {
  const publicId = buildPublicId(input);
  const folder = buildFolder(input);
  return new Promise<UploadApiResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cloudinary: upload timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const stream = uploader.upload_stream(
      {
        public_id: publicId.replace(`${folder}/`, ''),
        folder,
        resource_type: 'image',
        format: 'jpg',
        overwrite: true,
      },
      (err, result) => {
        clearTimeout(timer);
        if (err) return reject(err);
        if (!result) return reject(new Error('cloudinary: no result in callback'));
        resolve(result);
      },
    );
    stream.end(input.jpg);
  });
}

async function uploadToLocal(
  input: CloudinaryUploadInput,
  deps: { writeFile: typeof fs.writeFile; mkdir: typeof fs.mkdir },
): Promise<{ relPath: string; absPath: string }> {
  const folder = path.join(config.CLOUDINARY_FALLBACK_LOCAL_DIR, input.ideaId);
  await deps.mkdir(folder, { recursive: true });
  const fileName = `${input.artifact ?? 'carousel'}-${String(input.slideIndex).padStart(2, '0')}.jpg`;
  const absPath = path.join(folder, fileName);
  await deps.writeFile(absPath, input.jpg);
  // Относительный путь под публичный nginx-роут CLOUDINARY_FALLBACK_LOCAL_DIR
  const relPath = path.relative(config.CLOUDINARY_FALLBACK_LOCAL_DIR, absPath);
  return { relPath, absPath };
}

export async function uploadCarouselImage(
  input: CloudinaryUploadInput,
  deps: CloudinaryDeps = {},
): Promise<CloudinaryUploadOutput> {
  const started = Date.now();
  const timeoutMs = deps.timeoutMs ?? 30_000;
  configureCloudinaryOnce();

  // _cloudinaryConfigured — true когда ENV заданы. deps.uploader — путь для тестов.
  // В проде нам важно: ENV есть → пробуем Cloudinary; в тестах с моком — тоже пробуем.
  const cloudinaryAvailable = _cloudinaryConfigured || Boolean(deps.uploader);
  if (cloudinaryAvailable) {
    try {
      const uploader = deps.uploader ?? cloudinary.uploader;
      const res = await uploadToCloudinary(input, uploader, timeoutMs);
      const durationMs = Date.now() - started;
      log.info(
        { ideaId: input.ideaId, slideIndex: input.slideIndex, publicId: res.public_id, durationMs },
        'cloudinary: uploaded',
      );
      return {
        url: res.secure_url,
        source: 'cloudinary',
        publicId: res.public_id,
        durationMs,
      };
    } catch (err) {
      log.warn(
        { ideaId: input.ideaId, slideIndex: input.slideIndex, err: (err as Error).message },
        'cloudinary: upload failed, falling back to local',
      );
    }
  }

  const writeFile = deps.writeFile ?? fs.writeFile;
  const mkdir = deps.mkdir ?? fs.mkdir;
  const { relPath, absPath } = await uploadToLocal(input, { writeFile, mkdir });
  const durationMs = Date.now() - started;
  // Публичный URL — через nginx, mapped на CLOUDINARY_FALLBACK_LOCAL_DIR.
  // Конкретный mountpoint /cdn/ настраивается в nginx.conf на VPS.
  const url = `${config.APP_PUBLIC_BASE_URL.replace(/\/$/, '')}/cdn/${relPath}`;
  log.info(
    { ideaId: input.ideaId, slideIndex: input.slideIndex, absPath, durationMs },
    'cloudinary: local fallback used',
  );
  return { url, source: 'local', publicId: relPath, durationMs };
}
