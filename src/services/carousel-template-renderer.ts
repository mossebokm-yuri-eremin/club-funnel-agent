// carousel-template-renderer — рендерит брендированный слайд карусели
// из SVG-шаблона + текста, без AI-картинок. Fallback когда:
//   • NANO_BANANA_PLACEHOLDER_MODE=true (Gemini недоступен/без билинга);
//   • Nano Banana упал и нужен degradation вместо чистого серого.
//
// Источник шаблонов (по приоритету):
//   1. GDrive folder GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID — Юрий правит SVG
//      в Figma/Inkscape, выгружает в папку GDrive (расшаренную на сервис-аккаунт).
//      Имена строго: cover.svg, body.svg, cta.svg.
//      Кэш TTL CAROUSEL_TEMPLATES_TTL_S (default 300s).
//   2. Fallback — локальные assets/carousel-templates/{cover,body,cta}.svg (в репо).
//
// Sharp + libvips/librsvg рендерит SVG → PNG 1080×1350.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { listFolderFiles, downloadFile, type GDriveFileMeta } from '../integrations/gdrive.js';

export type SlideTemplate = 'cover' | 'body' | 'cta';

export interface TemplateRenderInput {
  template: SlideTemplate;
  text: string;
  slideIndex?: number; // 1-based для body
  totalSlides?: number;
  kicker?: string;     // для cover
}

export interface TemplateRenderOutput {
  png: Buffer;
  bytes: number;
}

const TEMPLATES_DIR_DEFAULT = path.resolve(process.cwd(), 'assets', 'carousel-templates');
const TARGET_W = 1080;
const TARGET_H = 1350;

interface CachedTemplate {
  svg: string;
  expiresAt: number;
  source: 'gdrive' | 'assets';
}

let _templateCache: Partial<Record<SlideTemplate, CachedTemplate>> = {};

function ttlMs(): number {
  return config.CAROUSEL_TEMPLATES_TTL_S * 1000;
}

async function loadFromGDrive(template: SlideTemplate, folderId: string): Promise<string> {
  const files = await listFolderFiles(folderId);
  const matched = files
    .filter(
      (f: GDriveFileMeta) =>
        f.name.toLowerCase() === `${template}.svg` &&
        (f.mimeType === 'image/svg+xml' || f.mimeType === 'text/xml' || f.mimeType === 'application/octet-stream'),
    )
    .sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  const pick = matched[0];
  if (!pick) {
    throw new Error(`gdrive: ${template}.svg не найден в папке ${folderId}`);
  }
  const buf = await downloadFile(pick.id);
  return buf.toString('utf8');
}

async function loadTemplate(template: SlideTemplate, dir: string): Promise<string> {
  const cached = _templateCache[template];
  if (cached && cached.expiresAt > Date.now()) return cached.svg;

  // 1) GDrive (если папка задана)
  const folderId = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID;
  if (folderId) {
    try {
      const svg = await loadFromGDrive(template, folderId);
      _templateCache[template] = {
        svg,
        expiresAt: Date.now() + ttlMs(),
        source: 'gdrive',
      };
      log.info({ template, folderId, bytes: svg.length }, 'template-renderer: loaded from GDrive');
      return svg;
    } catch (err) {
      log.warn(
        { template, err: (err as Error).message },
        'template-renderer: GDrive load failed, fallback to assets/',
      );
    }
  }

  // 2) Локальный fallback
  const filePath = path.join(dir, `${template}.svg`);
  const svg = await fs.readFile(filePath, 'utf8');
  _templateCache[template] = {
    svg,
    expiresAt: Date.now() + ttlMs(),
    source: 'assets',
  };
  log.debug({ template, source: 'assets' }, 'template-renderer: loaded from local assets');
  return svg;
}

/** Сбрасывает кэш — для тестов / после правки шаблонов в GDrive (см. /refresh_templates). */
export function clearTemplateCache(): void {
  _templateCache = {};
}

/** Экранирует XML-спец-символы. Для текста, который попадает в foreignObject (HTML) — заменяем кавычки. */
function escapeForSvgHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Подбирает font-size в зависимости от длины текста — чтобы длинные слайды не вылезали за canvas. */
function autoFontSize(template: SlideTemplate, text: string): number {
  const len = text.length;
  switch (template) {
    case 'cover':
      if (len > 180) return 56;
      if (len > 120) return 68;
      if (len > 60) return 76;
      return 84;
    case 'cta':
      if (len > 180) return 52;
      if (len > 120) return 62;
      if (len > 60) return 70;
      return 78;
    case 'body':
    default:
      if (len > 240) return 38;
      if (len > 160) return 44;
      if (len > 80) return 50;
      return 56;
  }
}

/** Рендерит один слайд из шаблона: подставляет TEXT/INDEX/TOTAL/KICKER + Sharp → PNG 1080×1350. */
export async function renderTemplateSlide(
  input: TemplateRenderInput,
  opts: { templatesDir?: string } = {},
): Promise<TemplateRenderOutput> {
  const dir = opts.templatesDir ?? TEMPLATES_DIR_DEFAULT;
  let svg = await loadTemplate(input.template, dir);

  const text = escapeForSvgHtml(input.text);
  const kicker = escapeForSvgHtml(input.kicker ?? 'НОВЫЙ ВЫПУСК');
  const index = input.slideIndex !== undefined ? String(input.slideIndex).padStart(2, '0') : '01';
  const total = input.totalSlides !== undefined ? String(input.totalSlides).padStart(2, '0') : '10';

  // Подмена размера шрифта под длину текста (только для main {{TEXT}}, не для kicker/index).
  const fontSize = autoFontSize(input.template, input.text);
  svg = svg
    .replace(/\{\{TEXT\}\}/g, text)
    .replace(/\{\{KICKER\}\}/g, kicker)
    .replace(/\{\{INDEX\}\}/g, index)
    .replace(/\{\{TOTAL\}\}/g, total)
    // Подмена дефолтных font-size в больших текстах — самый простой способ
    // без шаблонизатора: ищем "font-size: 84px" (cover), 78px (cta), 56px (body).
    .replace(/font-size:\s*84px/g, `font-size: ${fontSize}px`)
    .replace(/font-size:\s*78px/g, `font-size: ${fontSize}px`)
    .replace(/font-size:\s*56px/g, `font-size: ${fontSize}px`);

  const png = await sharp(Buffer.from(svg, 'utf8'), { density: 144 })
    .resize(TARGET_W, TARGET_H, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();

  log.debug(
    { template: input.template, textLen: input.text.length, fontSize, bytes: png.length },
    'template-renderer: slide rendered',
  );
  return { png, bytes: png.length };
}

/**
 * Решает какой шаблон применить к слайду на основе его позиции:
 *   1-й → cover, последний → cta, остальные → body.
 */
export function pickTemplateForSlide(slideIndex: number, totalSlides: number): SlideTemplate {
  if (slideIndex === 1) return 'cover';
  if (slideIndex >= totalSlides) return 'cta';
  return 'body';
}
