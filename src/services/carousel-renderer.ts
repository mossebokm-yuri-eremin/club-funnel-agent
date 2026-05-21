// carousel-renderer — оркестрация рендера каруселей (SPEC §2.7 AC-19..21).
//
// Phase 9 (style-transfer):
//   1. Читаем content_packages — берём voice_code, carousel_slides (JSON массив строк), idea.
//   2. ОДИН раз классифицируем тему карусели (regex + Haiku fallback) → имя папки эталона в GDrive.
//   3. ОДИН раз скачиваем reference-слайды (cover/body/cta) + опц. портрет + past-post.
//   4. Для каждого слайда: Seedream-4 через GPTunnel со style-reference (images[]) →
//      Sharp overlay русского текста → 1080×1350 JPG → upload (Cloudinary/local).
//   5. UPDATE content_packages.assets, INSERT в carousel_template_usage.
//
// Voice-validator НЕ применяем (это бинарь, не текст).

import type { Pool } from 'pg';
import { z } from 'zod';
import { uploadCarouselImage } from '../integrations/cloudinary.js';
import { log } from '../observability/logger.js';
import { classifyCarouselTheme, type VoiceCode } from './theme-classifier.js';
import {
  selectCarouselReferences,
  type SelectedTemplate,
  type TemplateSlideRef,
} from './carousel-template-selector.js';

export interface CarouselRendererInput {
  contentPackageId: string;
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
  /** Тема (для approval-notifier «✨ Вдохновлено: …»). */
  theme?: string;
  /** Имя папки эталона в GDrive. */
  templateFolderName?: string;
  /** 'regex' | 'llm' | 'fallback'. */
  classifiedBy?: 'regex' | 'llm' | 'fallback';
}

export interface CarouselRendererDeps {
  pool: Pool;
  uploadFn?: typeof uploadCarouselImage;
}

const CarouselSlidesSchema = z.array(z.string().min(1)).min(1);

interface ContentPackageRow {
  id: string;
  idea_id: string;
  voice_code: string;
  carousel_slides: unknown;
}

interface IdeaRow {
  id: string;
  pain_tag: string | null;
  summary: string | null;
}

async function fetchPackage(pool: Pool, id: string): Promise<ContentPackageRow | null> {
  const r = await pool.query<ContentPackageRow>(
    `SELECT id, idea_id, voice_code, carousel_slides FROM content_packages WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

async function fetchIdea(pool: Pool, id: string): Promise<IdeaRow | null> {
  const r = await pool.query<IdeaRow>(
    `SELECT id, pain_tag, summary FROM ideas WHERE id = $1`,
    [id],
  );
  return r.rows[0] ?? null;
}

function parseSlides(value: unknown): string[] {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  return CarouselSlidesSchema.parse(data);
}

function normalizeVoice(code: string): VoiceCode {
  return code === 'RZ' ? 'RZ' : 'YE';
}

export async function renderCarousel(
  input: CarouselRendererInput,
  deps: CarouselRendererDeps,
): Promise<CarouselRendererResult> {
  const started = Date.now();
  const uploadFn = deps.uploadFn ?? uploadCarouselImage;

  const pkg = await fetchPackage(deps.pool, input.contentPackageId);
  if (!pkg) throw new Error(`carousel-renderer: content_package ${input.contentPackageId} not found`);

  const idea = await fetchIdea(deps.pool, pkg.idea_id);
  if (!idea) throw new Error(`carousel-renderer: idea ${pkg.idea_id} not found`);

  const slidesText = parseSlides(pkg.carousel_slides);
  const totalSlides = slidesText.length;
  const voice = normalizeVoice(pkg.voice_code);

  log.info(
    { contentPackageId: pkg.id, ideaId: idea.id, totalSlides, voice },
    'carousel-renderer: started',
  );

  // ─── 1) Классификация темы (один раз на карусель) ─────────────────────────
  const classifierInput = [idea.summary ?? '', ...slidesText].join('\n').slice(0, 4000);
  const classification = await classifyCarouselTheme(classifierInput, voice);
  log.info(
    {
      contentPackageId: pkg.id,
      theme: classification.theme,
      template: classification.templateFolderName,
      by: classification.classifiedBy,
    },
    'carousel-renderer: theme classified',
  );

  // ─── 2) Скачиваем reference-слайды (один раз на карусель) ─────────────────
  let selected: SelectedTemplate | null = null;
  try {
    selected = await selectCarouselReferences({
      templateFolderName: classification.templateFolderName,
      voice,
      includePortrait: true,
      includePastPost: voice === 'YE',
    });
  } catch (err) {
    log.warn(
      { err: (err as Error).message, template: classification.templateFolderName },
      'carousel-renderer: reference selection failed (continuing without refs)',
    );
  }

  const allRefs: TemplateSlideRef[] = selected?.refs ?? [];
  const styleRefs = allRefs.filter((r) => r.role === 'cover' || r.role === 'body' || r.role === 'cta');
  const portraitRef = allRefs.find((r) => r.role === 'portrait');
  const pastPostRef = allRefs.find((r) => r.role === 'past-post');

  // ─── 3) Загрузка тяжёлых модулей (один раз) ───────────────────────────────
  const [
    { generateGptunnelImage, downloadGptunnelImage },
    { buildSeedreamVisualPrompt },
    { overlayTextOnImage },
    { recordImageGeneration },
  ] = await Promise.all([
    import('../integrations/gptunnel-creative.js'),
    import('../prompts/carousel-image.v1.js'),
    import('./text-overlay.js'),
    import('./image-billing.js'),
  ]);

  const rendered: RenderedSlide[] = [];

  for (let i = 0; i < slidesText.length; i++) {
    const slideText = slidesText[i];
    if (!slideText) continue;
    const slideIndex = i + 1;
    const slideStarted = Date.now();
    const isCover = slideIndex === 1;
    const isCta = slideIndex === totalSlides && totalSlides > 1;

    // Reference set для слайда:
    //   cover  — все style-refs + portrait + past-post (стиль + лицо + узнаваемый бренд)
    //   cta    — все style-refs (хочется CTA как в эталоне)
    //   body   — только body-ref + past-post (минимально, чтоб не тянуть лица в каждый слайд)
    let refSet: TemplateSlideRef[];
    if (isCover) {
      refSet = [...styleRefs, ...(portraitRef ? [portraitRef] : []), ...(pastPostRef ? [pastPostRef] : [])];
    } else if (isCta) {
      refSet = styleRefs;
    } else {
      const bodyRef = styleRefs.find((r) => r.role === 'body') ?? styleRefs[0];
      refSet = [...(bodyRef ? [bodyRef] : []), ...(pastPostRef ? [pastPostRef] : [])];
    }
    const referenceImages = refSet.map((r) => r.dataUrl);

    const visualPrompt = buildSeedreamVisualPrompt({
      slideText,
      slideIndex,
      totalSlides,
      painTag: idea.pain_tag ?? '',
    });

    let gen: Awaited<ReturnType<typeof generateGptunnelImage>>;
    try {
      gen = await generateGptunnelImage({
        prompt: visualPrompt,
        aspectRatio: '9:16',
        size: '2K',
        referenceImages,
      });
    } catch (err) {
      await recordImageGeneration(deps.pool, {
        contentPackageId: pkg.id,
        slideNumber: slideIndex,
        model: 'seedream-4',
        provider: 'gptunnel',
        prompt: visualPrompt,
        costKopecks: 0,
        ...(idea.pain_tag ? { painTag: idea.pain_tag } : {}),
        status: 'error',
        errorMessage: (err as Error).message.slice(0, 500),
      });
      throw err;
    }

    const rawPng = await downloadGptunnelImage(gen.imageUrl);
    const overlay = await overlayTextOnImage({
      imageBuffer: rawPng,
      text: slideText,
      slideIndex,
      totalSlides,
      ...(idea.pain_tag ? { painTag: idea.pain_tag } : {}),
    });

    await recordImageGeneration(deps.pool, {
      contentPackageId: pkg.id,
      slideNumber: slideIndex,
      model: gen.modelUsed,
      provider: 'gptunnel',
      prompt: visualPrompt,
      imageUrlExternal: gen.imageUrl,
      generationId: gen.generationId,
      costKopecks: gen.costKopecks,
      durationMs: gen.durationMs,
      bytes: overlay.bytes,
      ...(idea.pain_tag ? { painTag: idea.pain_tag } : {}),
      status: 'ok',
    });

    const composed = { jpg: overlay.jpg, meta: { bytes: overlay.bytes } };
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
        refsUsed: referenceImages.length,
        costKopecks: gen.costKopecks,
        durationMs: slideDurationMs,
      },
      'carousel-renderer: slide rendered',
    );
  }

  // ─── 4) UPDATE content_packages.assets ────────────────────────────────────
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
        template: {
          theme: classification.theme,
          folder: classification.templateFolderName,
          classified_by: classification.classifiedBy,
        },
      }),
    ],
  );

  // ─── 5) Аналитика использования шаблонов ──────────────────────────────────
  try {
    await deps.pool.query(
      `INSERT INTO carousel_template_usage
         (content_package_id, voice_code, theme, template_folder,
          reference_slide_ids, classified_by_llm, classifier_raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pkg.id,
        voice,
        classification.theme,
        classification.templateFolderName,
        allRefs.map((r) => r.fileId),
        classification.classifiedBy === 'llm',
        classification.classifierRaw ?? null,
      ],
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, contentPackageId: pkg.id },
      'carousel-renderer: failed to log carousel_template_usage (non-fatal)',
    );
  }

  const totalDurationMs = Date.now() - started;
  log.info(
    {
      contentPackageId: pkg.id,
      ideaId: idea.id,
      slidesRendered: rendered.length,
      theme: classification.theme,
      template: classification.templateFolderName,
      totalDurationMs,
    },
    'carousel-renderer: done',
  );

  return {
    contentPackageId: pkg.id,
    ideaId: idea.id,
    slides: rendered,
    totalDurationMs,
    theme: classification.theme,
    templateFolderName: classification.templateFolderName,
    classifiedBy: classification.classifiedBy,
  };
}
