// carousel-renderer — оркестрация рендера каруселей (SPEC §2.7 AC-19..21).
//
// Phase 12 (edit-mode через nano-banana-2):
//   1. Читаем content_packages → voice_code, carousel_slides[], idea.
//   2. ОДИН раз classifyCarouselTheme → имя эталонной папки (carousel-03-money …).
//   3. Берём кэшированные эталонные слайды из БД carousel_template_slides
//      (заранее залиты template-sync в /var/www/cdn/templates/, nginx раздаёт).
//   4. Для каждого нового слайда: nano-banana-2.editImage с base=<эталон.slide_N>
//      → результат скачиваем, кладём в /var/www/cdn/<ideaId>/carousel-NN.jpg.
//   5. Параллельно через Promise.all (с лимитом concurrency).
//   6. UPDATE content_packages.assets, INSERT в carousel_template_usage.
//
// CAROUSEL_MODE flag:
//   'edit'            — nano-banana-2 edit от эталона (текущая стратегия)
//   'style_transfer'  — старая Seedream-4 + style refs (fallback, не используется)
//
// Voice-validator НЕ применяем (это бинарь, не текст).

import type { Pool } from 'pg';
import { z } from 'zod';
import { uploadCarouselImage } from '../integrations/cloudinary.js';
import { log } from '../observability/logger.js';
import { config } from '../config.js';
import { classifyCarouselTheme, type VoiceCode } from './theme-classifier.js';

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
  theme?: string;
  templateFolderName?: string;
  classifiedBy?: 'regex' | 'llm' | 'fallback';
  mode?: 'edit' | 'style_transfer';
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

interface TemplateSlideRow {
  slide_number: number;
  public_url: string;
  drive_file_id: string;
}

function parseSlides(value: unknown): string[] {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  return CarouselSlidesSchema.parse(data);
}

function normalizeVoice(code: string): VoiceCode {
  return code === 'RZ' ? 'RZ' : 'YE';
}

function pickBaseSlide(
  templates: TemplateSlideRow[],
  newSlideIndex: number,
  isCover: boolean,
  isCta: boolean,
): TemplateSlideRow {
  // Базовая логика: slide N в новой карусели → slide N в эталоне.
  // Если в эталоне меньше слайдов — циклим. Cover/CTA пытаемся подобрать первый/последний.
  if (templates.length === 0) throw new Error('pickBaseSlide: no templates');
  if (isCover) return templates[0]!;
  if (isCta) return templates[templates.length - 1]!;
  // Body: prefer same index, fallback by modulo.
  const idx = (newSlideIndex - 1) % templates.length;
  return templates[idx]!;
}

function buildEditPrompt(slideText: string, slideIndex: number, totalSlides: number): string {
  const role =
    slideIndex === 1
      ? 'cover'
      : slideIndex === totalSlides && totalSlides > 1
        ? 'call-to-action'
        : 'body';
  return [
    `Replace the Russian text on this carousel ${role} slide with the new Russian text below.`,
    `New text: «${slideText}»`,
    '',
    'CRITICAL — text must FIT inside the original text area:',
    '- Adjust font size DOWN if the new text is longer than the original, so EVERY character including first and last letter stays fully inside the safe area (do not let any letter touch or cross the edge).',
    '- Keep word wrapping (break onto multiple lines) so the line length matches the original layout.',
    '- Do NOT enlarge the text area — work within the same bounding box as the original.',
    '- Keep at least 60 px of padding from all four edges of the canvas.',
    '',
    'Preserve EVERYTHING else exactly: layout, design elements, colors, fonts, photos, illustrations, composition, background, watermark, page-number indicator.',
    'Match the original typography style — same font family, weight, color, alignment, hierarchy. Only font SIZE may shrink to fit.',
    'Only the text content changes. Do not regenerate or alter photos/illustrations/background.',
  ].join('\n');
}

async function renderViaEdit(
  pool: Pool,
  pkg: ContentPackageRow,
  idea: IdeaRow,
  slidesText: string[],
  voice: VoiceCode,
  theme: string,
  templateFolderName: string,
  classifiedBy: 'regex' | 'llm' | 'fallback',
  uploadFn: typeof uploadCarouselImage,
): Promise<CarouselRendererResult> {
  const started = Date.now();
  const totalSlides = slidesText.length;
  const voiceLower = voice.toLowerCase();

  // 1. Берём эталонные слайды из БД.
  const tplRes = await pool.query<TemplateSlideRow>(
    `SELECT slide_number, public_url, drive_file_id
       FROM carousel_template_slides
      WHERE voice = $1 AND carousel_name = $2
      ORDER BY slide_number ASC`,
    [voiceLower, templateFolderName],
  );
  const templates = tplRes.rows;
  if (templates.length === 0) {
    throw new Error(
      `renderViaEdit: no template slides in БД for voice=${voiceLower} carousel=${templateFolderName} — запусти sync-templates.ts`,
    );
  }
  log.info(
    { theme, templateFolderName, templateCount: templates.length, totalSlides },
    'carousel-renderer[edit]: templates loaded',
  );

  // 2. Подгружаем editImage + Sharp resize.
  const [{ editImage, downloadGptunnelImage }, { recordImageGeneration }, sharp] = await Promise.all([
    import('../integrations/gptunnel-creative.js'),
    import('./image-billing.js'),
    import('sharp').then((m) => m.default),
  ]);

  const editModel = (config.GPTUNNEL_EDIT_MODEL ?? 'nano-banana-2') as
    | 'nano-banana'
    | 'nano-banana-2'
    | 'gpt-image-1.5-low';
  const concurrency = Math.max(1, Math.min(10, config.CAROUSEL_EDIT_CONCURRENCY ?? 4));

  // 3. Параллельно рендерим слайды (Promise pool).
  const tasks: Array<() => Promise<RenderedSlide>> = slidesText.map((slideText, i) => async () => {
    if (!slideText) throw new Error(`slide ${i + 1} empty`);
    const slideIndex = i + 1;
    const isCover = slideIndex === 1;
    const isCta = slideIndex === totalSlides && totalSlides > 1;
    const base = pickBaseSlide(templates, slideIndex, isCover, isCta);
    const prompt = buildEditPrompt(slideText, slideIndex, totalSlides);
    const slideStarted = Date.now();

    let edit: Awaited<ReturnType<typeof editImage>>;
    try {
      edit = await editImage({
        model: editModel,
        prompt,
        imageUrls: [base.public_url],
      });
    } catch (err) {
      await recordImageGeneration(pool, {
        contentPackageId: pkg.id,
        slideNumber: slideIndex,
        model: editModel,
        provider: 'gptunnel',
        prompt,
        costKopecks: 0,
        ...(idea.pain_tag ? { painTag: idea.pain_tag } : {}),
        status: 'error',
        errorMessage: (err as Error).message.slice(0, 500),
      });
      throw err;
    }

    // Скачиваем + ресайз до 1080×1350 JPG.
    const raw = await downloadGptunnelImage(edit.imageUrl);
    const finalJpg = await sharp(raw)
      .resize(1080, 1350, { fit: 'cover' })
      .jpeg({ quality: 90 })
      .toBuffer();

    const uploaded = await uploadFn({
      jpg: finalJpg,
      ideaId: idea.id,
      slideIndex,
      artifact: 'carousel',
    });

    await recordImageGeneration(pool, {
      contentPackageId: pkg.id,
      slideNumber: slideIndex,
      model: edit.modelUsed,
      provider: 'gptunnel',
      prompt,
      imageUrlExternal: edit.imageUrl,
      generationId: edit.taskId,
      costKopecks: edit.costKopecks,
      durationMs: edit.durationMs,
      bytes: finalJpg.length,
      ...(idea.pain_tag ? { painTag: idea.pain_tag } : {}),
      status: 'ok',
    });

    log.info(
      {
        contentPackageId: pkg.id,
        slideIndex,
        baseSlide: base.slide_number,
        url: uploaded.url,
        bytes: finalJpg.length,
        costKopecks: edit.costKopecks,
        durationMs: Date.now() - slideStarted,
      },
      'carousel-renderer[edit]: slide rendered',
    );

    return {
      index: slideIndex,
      url: uploaded.url,
      source: uploaded.source,
      publicId: uploaded.publicId,
      bytes: finalJpg.length,
      durationMs: Date.now() - slideStarted,
    };
  });

  // Concurrency-limited execution.
  const rendered: RenderedSlide[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const my = cursor++;
      const task = tasks[my]!;
      const result = await task();
      rendered[my] = result;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 4. UPDATE content_packages.assets
  await pool.query(
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
          theme,
          folder: templateFolderName,
          classified_by: classifiedBy,
          mode: 'edit',
          model: editModel,
        },
      }),
    ],
  );

  // 5. Аналитика.
  try {
    await pool.query(
      `INSERT INTO carousel_template_usage
         (content_package_id, voice_code, theme, template_folder,
          reference_slide_ids, classified_by_llm, classifier_raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        pkg.id,
        voice,
        theme,
        templateFolderName,
        templates.map((t) => t.drive_file_id),
        classifiedBy === 'llm',
        null,
      ],
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, contentPackageId: pkg.id },
      'carousel-renderer[edit]: failed to log carousel_template_usage (non-fatal)',
    );
  }

  const totalDurationMs = Date.now() - started;
  log.info(
    {
      contentPackageId: pkg.id,
      ideaId: idea.id,
      slidesRendered: rendered.length,
      theme,
      template: templateFolderName,
      model: editModel,
      concurrency,
      totalDurationMs,
    },
    'carousel-renderer[edit]: done',
  );

  return {
    contentPackageId: pkg.id,
    ideaId: idea.id,
    slides: rendered,
    totalDurationMs,
    theme,
    templateFolderName,
    classifiedBy,
    mode: 'edit',
  };
}

export async function renderCarousel(
  input: CarouselRendererInput,
  deps: CarouselRendererDeps,
): Promise<CarouselRendererResult> {
  const uploadFn = deps.uploadFn ?? uploadCarouselImage;

  const pkgRes = await deps.pool.query<ContentPackageRow>(
    `SELECT id, idea_id, voice_code, carousel_slides FROM content_packages WHERE id = $1`,
    [input.contentPackageId],
  );
  const pkg = pkgRes.rows[0];
  if (!pkg) throw new Error(`carousel-renderer: content_package ${input.contentPackageId} not found`);

  const ideaRes = await deps.pool.query<IdeaRow>(
    `SELECT id, pain_tag, summary FROM ideas WHERE id = $1`,
    [pkg.idea_id],
  );
  const idea = ideaRes.rows[0];
  if (!idea) throw new Error(`carousel-renderer: idea ${pkg.idea_id} not found`);

  const slidesText = parseSlides(pkg.carousel_slides);
  const voice = normalizeVoice(pkg.voice_code);

  log.info(
    { contentPackageId: pkg.id, ideaId: idea.id, totalSlides: slidesText.length, voice },
    'carousel-renderer: started',
  );

  // Override: если CAROUSEL_FORCE_TEMPLATE задан — пропускаем classify, используем фикс.
  const forceTpl = config.CAROUSEL_FORCE_TEMPLATE;
  let classification: { theme: string; templateFolderName: string; classifiedBy: 'regex' | 'llm' | 'fallback'; classifierRaw?: string };
  if (forceTpl) {
    classification = { theme: 'forced', templateFolderName: forceTpl, classifiedBy: 'fallback' };
    log.info(
      { contentPackageId: pkg.id, template: forceTpl, forced: true },
      'carousel-renderer: theme classification SKIPPED (CAROUSEL_FORCE_TEMPLATE)',
    );
  } else {
    const classifierInput = [idea.summary ?? '', ...slidesText].join('\n').slice(0, 4000);
    classification = await classifyCarouselTheme(classifierInput, voice);
    log.info(
      {
        contentPackageId: pkg.id,
        theme: classification.theme,
        template: classification.templateFolderName,
        by: classification.classifiedBy,
      },
      'carousel-renderer: theme classified',
    );
  }

  // CAROUSEL_MODE switch (default = edit).
  const mode = (config.CAROUSEL_MODE ?? 'edit') as 'html' | 'edit' | 'style_transfer';

  if (mode === 'html') {
    // Phase 14: HTML+Puppeteer pipeline.
    const { renderCarouselHtml } = await import('../integrations/html-carousel-renderer.js');
    // Достаём bonusTitle при необходимости.
    let bonusTitle: string | undefined;
    const bonusRes = await deps.pool.query<{ title: string }>(
      `SELECT b.title FROM ideas i LEFT JOIN bonus_library b ON b.id = i.bonus_id WHERE i.id = $1`,
      [idea.id],
    );
    if (bonusRes.rows[0]?.title) bonusTitle = bonusRes.rows[0].title;
    if (!idea.summary) {
      throw new Error('carousel-renderer[html]: idea.summary is null — cannot build payload');
    }
    const htmlInput: Parameters<typeof renderCarouselHtml>[1] = {
      contentPackageId: pkg.id,
      ideaId: idea.id,
      slidesText,
      ideaSummary: idea.summary,
      painTag: idea.pain_tag ?? '',
      strategy: (idea.summary && classification.classifiedBy === 'fallback') ? 'B' : 'B', // strategy уже выбрана в content-worker; читать из ideas.strategy
      codeWord: 'preview', // будет переопределён через approval-callback; для smoke берём из env или фикс.
    };
    if (bonusTitle) htmlInput.bonusTitle = bonusTitle;

    // Реально strategy + codeWord нужны → читаем из ideas + funnels.
    const stratRes = await deps.pool.query<{ strategy: 'A' | 'B' | 'C' | null }>(
      `SELECT strategy FROM ideas WHERE id = $1`,
      [idea.id],
    );
    htmlInput.strategy = (stratRes.rows[0]?.strategy ?? 'B') as 'A' | 'B' | 'C';
    const fnRes = await deps.pool.query<{ code_word: string }>(
      `SELECT code_word FROM funnels WHERE idea_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [idea.id],
    );
    if (fnRes.rows[0]?.code_word) htmlInput.codeWord = fnRes.rows[0].code_word;

    const htmlResult = await renderCarouselHtml(deps.pool, htmlInput, uploadFn);

    // UPDATE content_packages.assets
    await deps.pool.query(
      `UPDATE content_packages
         SET assets = COALESCE(assets, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
       WHERE id = $1`,
      [
        pkg.id,
        JSON.stringify({
          slides: htmlResult.slides.map((r) => r.url),
          slides_meta: htmlResult.slides.map((r) => ({
            index: r.index,
            url: r.url,
            source: r.source,
            public_id: r.publicId,
          })),
          template: {
            theme: classification.theme,
            folder: classification.templateFolderName,
            classified_by: classification.classifiedBy,
            mode: 'html',
            template_name: htmlResult.templateName,
          },
        }),
      ],
    );

    return {
      contentPackageId: pkg.id,
      ideaId: idea.id,
      slides: htmlResult.slides,
      totalDurationMs: htmlResult.totalDurationMs,
      theme: classification.theme,
      templateFolderName: htmlResult.templateName,
      classifiedBy: classification.classifiedBy,
      mode: 'edit', // отчёт unifies under 'edit' for type-safe; в assets отдельное поле 'html'.
    };
  }

  if (mode === 'edit') {
    return renderViaEdit(
      deps.pool,
      pkg,
      idea,
      slidesText,
      voice,
      classification.theme,
      classification.templateFolderName,
      classification.classifiedBy,
      uploadFn,
    );
  }

  // Legacy: старый style_transfer flow (если CAROUSEL_MODE=style_transfer).
  throw new Error(
    `carousel-renderer: CAROUSEL_MODE=${mode} not implemented in this code path. ` +
      `Use CAROUSEL_MODE=html or edit.`,
  );
}
