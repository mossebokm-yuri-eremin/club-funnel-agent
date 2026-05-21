// carousel-template-selector — скачивает 2-3 эталонных слайда из выбранной
// карусели в GDrive + 1 портрет Юрия (для cover) → возвращает base64-images
// для передачи в Seedream через images[].
//
// Кэш файлов — в /var/club-funnel/template-cache/ (см. gdrive.ts downloadAndCache).

import { config } from '../config.js';
import { log } from '../observability/logger.js';
import {
  listFolderFiles,
  getFolderIdByName,
  downloadAndCache,
  type GDriveFileMeta,
} from '../integrations/gdrive.js';
import type { VoiceCode } from './theme-classifier.js';

const YE_TEMPLATES_PARENT_FOLDER = '04-carousel-templates-ye';
const RZ_TEMPLATES_PARENT_FOLDER = '05-carousel-templates-rz';
const YURI_PHOTOS_FOLDER = '01-yuri-photos';
const VIKTORIYA_PHOTOS_FOLDER = '02-viktoriya-photos';

export interface TemplateSlideRef {
  fileId: string;
  fileName: string;
  /** 'data:image/jpeg;base64,...' — формат для передачи в API. */
  dataUrl: string;
  /** Чистый base64 без data: prefix — для API, которые принимают raw. */
  base64: string;
  bytes: number;
  role: 'cover' | 'body' | 'cta' | 'portrait' | 'past-post';
}

export interface SelectedTemplate {
  /** Имя папки эталона ('carousel-03-money', 'carousel-01-designers' etc). */
  folderName: string;
  /** file_id папки в GDrive. */
  folderId: string;
  /** Reference-слайды (cover/body/cta) + опц. портрет. */
  refs: TemplateSlideRef[];
  /** Сколько всего слайдов в эталоне (для аналитики). */
  totalSlidesInTemplate: number;
  voice: VoiceCode;
}

const cachedRootIds: Record<string, string> = {};

/** Сбрасывает in-memory кэш resolved folder-id (после правки в GDrive). */
export function clearTemplateCache(): void {
  for (const k of Object.keys(cachedRootIds)) delete cachedRootIds[k];
}

async function resolveRootFolderId(parentName: string): Promise<string | null> {
  if (cachedRootIds[parentName]) return cachedRootIds[parentName]!;
  const root = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID;
  if (!root) {
    log.warn({}, 'template-selector: GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID not set');
    return null;
  }
  const id = await getFolderIdByName(root, parentName);
  if (id) cachedRootIds[parentName] = id;
  return id;
}

/** Числовая сортировка по числам в имени (slide-01.png, slide-2.png — natural order). */
function naturalSort(a: GDriveFileMeta, b: GDriveFileMeta): number {
  const an = parseInt(a.name.match(/\d+/)?.[0] ?? '0', 10);
  const bn = parseInt(b.name.match(/\d+/)?.[0] ?? '0', 10);
  if (an !== bn) return an - bn;
  return a.name.localeCompare(b.name);
}

/** Выбирает 3 индекса (cover/body/cta) из массива слайдов любого размера. */
function pickThreeIndexes(count: number): { cover: number; body: number; cta: number } {
  if (count === 0) return { cover: -1, body: -1, cta: -1 };
  if (count === 1) return { cover: 0, body: 0, cta: 0 };
  if (count === 2) return { cover: 0, body: 0, cta: 1 };
  return {
    cover: 0,
    body: Math.floor(count / 2),
    cta: count - 1,
  };
}

async function downloadAsRef(
  file: GDriveFileMeta,
  role: TemplateSlideRef['role'],
): Promise<TemplateSlideRef> {
  const cached = await downloadAndCache(file.id, { mimeHint: file.mimeType });
  const base64 = cached.buf.toString('base64');
  return {
    fileId: file.id,
    fileName: file.name,
    dataUrl: `data:${file.mimeType};base64,${base64}`,
    base64,
    bytes: cached.buf.length,
    role,
  };
}

async function listImagesOnly(folderId: string): Promise<GDriveFileMeta[]> {
  const items = await listFolderFiles(folderId);
  return items
    .filter((f) => f.mimeType.startsWith('image/'))
    .sort(naturalSort);
}

/**
 * Главная функция: по теме + голосу скачивает 3 reference-слайда (cover/body/cta).
 * Опционально добавляет 1 портрет (Юрий для YE, Виктория для RZ — если есть).
 */
export async function selectCarouselReferences(opts: {
  templateFolderName: string;
  voice: VoiceCode;
  /** Включить ли портрет в reference set (для cover-слайда — да, для body — нет). */
  includePortrait?: boolean;
  /** Из 08-yuri-past-posts взять 1 PNG для дополнительного style-ref. */
  includePastPost?: boolean;
}): Promise<SelectedTemplate | null> {
  const parentName =
    opts.voice === 'YE' ? YE_TEMPLATES_PARENT_FOLDER : RZ_TEMPLATES_PARENT_FOLDER;
  const parentId = await resolveRootFolderId(parentName);
  if (!parentId) {
    log.warn({ parentName }, 'template-selector: parent folder not found');
    return null;
  }

  const templateFolderId = await getFolderIdByName(parentId, opts.templateFolderName);
  if (!templateFolderId) {
    log.warn(
      { parentName, templateFolderName: opts.templateFolderName },
      'template-selector: template folder not found',
    );
    return null;
  }

  // Берём только image/* из эталонной карусели.
  let slides = await listImagesOnly(templateFolderId);

  // Если внутри template-папки нет картинок — может быть вложенность ещё на уровень.
  // Например: 04-carousel-templates-ye/carousel-03-money/slides/*.png
  if (slides.length === 0) {
    const sub = await listFolderFiles(templateFolderId);
    for (const f of sub) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const inner = await listImagesOnly(f.id);
        if (inner.length > 0) {
          slides = inner;
          break;
        }
      }
    }
  }

  if (slides.length === 0) {
    log.warn(
      { templateFolderName: opts.templateFolderName },
      'template-selector: no slides found in template',
    );
    return {
      folderName: opts.templateFolderName,
      folderId: templateFolderId,
      refs: [],
      totalSlidesInTemplate: 0,
      voice: opts.voice,
    };
  }

  const idx = pickThreeIndexes(slides.length);
  const refs: TemplateSlideRef[] = [];
  // Cover
  if (slides[idx.cover]) refs.push(await downloadAsRef(slides[idx.cover]!, 'cover'));
  // Body (если отличается от cover)
  if (idx.body !== idx.cover && slides[idx.body]) {
    refs.push(await downloadAsRef(slides[idx.body]!, 'body'));
  }
  // CTA (если отличается от cover и body)
  if (idx.cta !== idx.cover && idx.cta !== idx.body && slides[idx.cta]) {
    refs.push(await downloadAsRef(slides[idx.cta]!, 'cta'));
  }

  // Опц. портрет — для cover-слайда нужно «лицо» автора.
  if (opts.includePortrait) {
    try {
      const photoFolderName = opts.voice === 'YE' ? YURI_PHOTOS_FOLDER : VIKTORIYA_PHOTOS_FOLDER;
      const photoFolderId = await resolveRootFolderId(photoFolderName);
      if (photoFolderId) {
        const photos = await listImagesOnly(photoFolderId);
        if (photos.length > 0) {
          // Берём первый портрет — простая стратегия для MVP.
          // TODO: ротация / matching по slideText (strict/smile/working).
          const ref = await downloadAsRef(photos[0]!, 'portrait');
          refs.push(ref);
        }
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, voice: opts.voice },
        'template-selector: portrait load failed (continuing without)',
      );
    }
  }

  // Опц. past-post — для добавления узнаваемого визуального стиля Юрия.
  if (opts.includePastPost && opts.voice === 'YE') {
    try {
      const pastFolderId = await resolveRootFolderId('08-yuri-past-posts');
      if (pastFolderId) {
        const posts = await listImagesOnly(pastFolderId);
        if (posts.length > 0) {
          const pick = posts[Math.floor(Math.random() * posts.length)]!;
          refs.push(await downloadAsRef(pick, 'past-post'));
        }
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'template-selector: past-post load failed',
      );
    }
  }

  log.info(
    {
      templateFolderName: opts.templateFolderName,
      voice: opts.voice,
      refsCount: refs.length,
      totalBytes: refs.reduce((a, r) => a + r.bytes, 0),
      includePortrait: opts.includePortrait,
      includePastPost: opts.includePastPost,
    },
    'template-selector: refs prepared',
  );

  return {
    folderName: opts.templateFolderName,
    folderId: templateFolderId,
    refs,
    totalSlidesInTemplate: slides.length,
    voice: opts.voice,
  };
}
