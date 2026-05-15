// carousel-renderer — оркестрация рендера каруселей (SPEC §2.7 AC-19..21).
//
// Вход: content_package_id (карусель там уже сгенерирована текстом в JSON-массиве слайдов).
// Шаги:
//   1. Читаем content_packages — достаём carousel_slides (массив строк) и idea_id + pain_tag.
//   2. Для каждого слайда — buildCarouselSlidePrompt → generateImage (Nano Banana) → composeSlide
//      (Sharp 1080×1350 + watermark) → uploadCarouselImage (Cloudinary / local fallback).
//   3. Собираем массив URL'ов → UPDATE content_packages.assets jsonb { carousel: [{url, source}] }.
//
// Voice-validator НЕ применяем (это бинарь, не текст).

import type { Pool } from 'pg';
import { z } from 'zod';
import { generateImage } from '../integrations/nano-banana.js';
import { uploadCarouselImage } from '../integrations/cloudinary.js';
import { composeSlide } from './image-composer.js';
import { buildCarouselSlidePrompt } from '../prompts/carousel-image.v1.js';
import { log } from '../observability/logger.js';

export interface CarouselRendererInput {
  contentPackageId: string;
  /** Опциональная подсказка стиля. */
  styleHint?: string;
}

export interface RenderedSlide {
  index: number;
  url: string;
  source: 'cloudinary' | 'local';
  publicId: string;
  bytes: number;
  durationMs: number;
}

export interface CarouselRendererResult {
  contentPackageId: string;
  ideaId: string;
  slides: RenderedSlide[];
  totalDurationMs: number;
}

export interface CarouselRendererDeps {
  pool: Pool;
  /** Override для тестов. */
  generateImageFn?: typeof generateImage;
  composeFn?: typeof composeSlide;
  uploadFn?: typeof uploadCarouselImage;
}

const CarouselSlidesSchema = z.array(z.string().min(1)).min(1);

interface ContentPackageRow {
  id: string;
  idea_id: string;
  carousel_slides: unknown;
}

interface IdeaRow {
  id: string;
  pain_tag: string | null;
}

async function fetchPackage(pool: Pool, id: string): Promise<ContentPackageRow | null> {
  const r = await pool.query<ContentPackageRow>(
    `SELECT id, idea_id, carousel_slides FROM content_packages WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function fetchIdea(pool: Pool, id: string): Promise<IdeaRow | null> {
  const r = await pool.query<IdeaRow>(
    `SELECT id, pain_tag FROM ideas WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

function parseSlides(value: unknown): string[] {
  // carousel_slides — JSONB; pg вернёт строку или объект в зависимости от приведения.
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  return CarouselSlidesSchema.parse(data);
}

export async function renderCarousel(
  input: CarouselRendererInput,
  deps: CarouselRendererDeps,
): Promise<CarouselRendererResult> {
  const started = Date.now();
  const generateImageFn = deps.generateImageFn ?? generateImage;
  const composeFn = deps.composeFn ?? composeSlide;
  const uploadFn = deps.uploadFn ?? uploadCarouselImage;

  const pkg = await fetchPackage(deps.pool, input.contentPackageId);
  if (!pkg) throw new Error(`carousel-renderer: content_package ${input.contentPackageId} not found`);

  const idea = await fetchIdea(deps.pool, pkg.idea_id);
  if (!idea) throw new Error(`carousel-renderer: idea ${pkg.idea_id} not found`);

  const slidesText = parseSlides(pkg.carousel_slides);
  const totalSlides = slidesText.length;

  log.info(
    { contentPackageId: pkg.id, ideaId: idea.id, totalSlides },
    'carousel-renderer: started',
  );

  const rendered: RenderedSlide[] = [];
  for (let i = 0; i < slidesText.length; i++) {
    const slideText = slidesText[i];
    if (!slideText) continue; // Type guard для exactOptionalPropertyTypes
    const slideIndex = i + 1;
    const slideStarted = Date.now();

    const promptInput: Parameters<typeof buildCarouselSlidePrompt>[0] = {
      slideText,
      slideIndex,
      totalSlides,
      painTag: idea.pain_tag ?? '',
    };
    if (input.styleHint) promptInput.styleHint = input.styleHint;
    const prompt = buildCarouselSlidePrompt(promptInput);

    // 1) Источник PNG: либо Nano Banana (AI), либо SVG-шаблон MOSSEBO.
    // Шаблон используется когда:
    //   • CAROUSEL_USE_TEMPLATES=true (явно), ИЛИ
    //   • PLACEHOLDER_MODE=true и нет AI-картинок (Gemini billing pending).
    // Шаблон даёт читаемый брендированный слайд без зависимости от Gemini.
    const { config: cfg } = await import('../config.js');
    const useTemplates =
      cfg.CAROUSEL_USE_TEMPLATES === true || cfg.NANO_BANANA_PLACEHOLDER_MODE === true;

    let composedPng: Buffer;
    if (useTemplates) {
      const { renderTemplateSlide, pickTemplateForSlide } = await import(
        './carousel-template-renderer.js'
      );
      const tmpl = pickTemplateForSlide(slideIndex, totalSlides);
      const tplOut = await renderTemplateSlide({
        template: tmpl,
        text: slideText,
        slideIndex,
        totalSlides,
        kicker: idea.pain_tag ? idea.pain_tag.toUpperCase().slice(0, 28) : 'РЕАЛИЗАЦИЯ',
      });
      composedPng = tplOut.png;
    } else {
      const imgOut = await generateImageFn({ prompt, aspectRatio: '4:5' });
      composedPng = imgOut.png;
    }
    // 2) Sharp 1080×1350 + watermark → JPG (SPEC AC-21)
    const composed = await composeFn({ png: composedPng });
    // 3) Upload → Cloudinary | local
    const uploaded = await uploadFn({
      jpg: composed.jpg,
      ideaId: idea.id,
      slideIndex,
      artifact: 'carousel',
    });

    const slideDurationMs = Date.now() - slideStarted;
    rendered.push({
      index: slideIndex,
      url: uploaded.url,
      source: uploaded.source,
      publicId: uploaded.publicId,
      bytes: composed.meta.bytes,
      durationMs: slideDurationMs,
    });
    log.info(
      {
        contentPackageId: pkg.id,
        slideIndex,
        url: uploaded.url,
        bytes: composed.meta.bytes,
        durationMs: slideDurationMs,
      },
      'carousel-renderer: slide rendered',
    );
  }

  // 4) UPDATE content_packages.assets — мерджим с существующим JSON.
  // Структура assets: { slides: ["url1", "url2", ...], slides_meta: [{...}] }.
  // SPEC §4 (строки 506-507): assets.slides — массив URL для replyWithMediaGroup.
  // slides_meta хранит расширенные данные (source, public_id) для аудита/диагностики.
  await deps.pool.query(
    `UPDATE content_packages
       SET assets = COALESCE(assets, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
     WHERE id = $1`,
    [
      pkg.id,
      JSON.stringify({
        slides: rendered.map((r) => r.url),
        slides_meta: rendered.map((r) => ({
          index: r.index,
          url: r.url,
          source: r.source,
          public_id: r.publicId,
        })),
      }),
    ],
  );

  const totalDurationMs = Date.now() - started;
  log.info(
    {
      contentPackageId: pkg.id,
      ideaId: idea.id,
      slidesRendered: rendered.length,
      totalDurationMs,
    },
    'carousel-renderer: done',
  );

  return {
    contentPackageId: pkg.id,
    ideaId: idea.id,
    slides: rendered,
    totalDurationMs,
  };
}
