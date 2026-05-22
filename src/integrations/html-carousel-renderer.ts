// html-carousel-renderer — Phase 14: рендер карусели через HTML+Puppeteer.
//
// CAROUSEL_MODE=html включает этот path.
// Pipeline:
//   1. ig-html-payload Sonnet 4.6 преобразует carousel_slides[] → slot-payload
//   2. Puppeteer открывает yury-universal-v1.html с заполненными плейсхолдерами
//   3. Для каждого #slide-N делает screenshot 1080×1350
//   4. Sharp → JPG → uploadFn → /var/www/cdn/<ideaId>/carousel-NN.jpg
//   5. image_generations: provider='html_puppeteer', cost_kopecks=0

import type { Pool } from 'pg';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { uploadCarouselImage } from './cloudinary.js';

const TEMPLATE_DIR = path.resolve(process.cwd(), 'src/templates/carousel-html');

export interface HtmlRenderInput {
  contentPackageId: string;
  ideaId: string;
  slidesText: string[];
  ideaSummary: string;
  painTag: string;
  strategy: 'A' | 'B' | 'C';
  codeWord: string;
  templateName?: string;
  bonusTitle?: string;
}

export interface HtmlRenderedSlide {
  index: number;
  url: string;
  source: 'cloudinary' | 'local';
  publicId: string;
  bytes: number;
  durationMs: number;
}

export interface HtmlRenderResult {
  slides: HtmlRenderedSlide[];
  templateName: string;
  totalDurationMs: number;
  payloadCostUsd: number;
}

function applyTemplate(html: string, data: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = data[key];
    return typeof v === 'string' ? v : '';
  });
}

export async function renderCarouselHtml(
  pool: Pool,
  input: HtmlRenderInput,
  uploadFn: typeof uploadCarouselImage = uploadCarouselImage,
): Promise<HtmlRenderResult> {
  const started = Date.now();
  const templateName = input.templateName ?? config.CAROUSEL_HTML_TEMPLATE ?? 'yury-universal-v1';
  const tplPath = path.join(TEMPLATE_DIR, `${templateName}.html`);
  const tpl = await readFile(tplPath, 'utf8');

  // 1. Sonnet payload.
  const { generateHtmlPayload } = await import('../services/ig-html-payload.js');
  const payloadInput: Parameters<typeof generateHtmlPayload>[0] = {
    slidesText: input.slidesText,
    ideaSummary: input.ideaSummary,
    painTag: input.painTag,
    strategy: input.strategy,
    codeWord: input.codeWord,
  };
  if (input.bonusTitle) payloadInput.bonusTitle = input.bonusTitle;
  const payload = await generateHtmlPayload(payloadInput);
  const html = applyTemplate(tpl, payload);

  // 2. Puppeteer.
  const tmpDir = `/tmp/carousel-html-${input.contentPackageId.slice(0, 8)}-${Date.now()}`;
  await mkdir(tmpDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });

  const rendered: HtmlRenderedSlide[] = [];
  const { recordImageGeneration } = await import('../services/image-billing.js');
  const sharp = (await import('sharp')).default;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 45_000 }); await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => ((globalThis as any).document)?.fonts?.ready);

    for (let i = 1; i <= 10; i++) {
      const slideStarted = Date.now();
      const el = await page.$(`#slide-${i}`);
      if (!el) {
        log.warn({ slideIndex: i }, 'html-renderer: slide element missing in template');
        continue;
      }
      const png = (await el.screenshot({ omitBackground: false, type: 'png' })) as Buffer;
      const jpg = await sharp(png).resize(1080, 1350, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();

      const uploaded = await uploadFn({
        jpg,
        ideaId: input.ideaId,
        slideIndex: i,
        artifact: 'carousel',
      });

      await recordImageGeneration(pool, {
        contentPackageId: input.contentPackageId,
        slideNumber: i,
        model: templateName,
        provider: 'html_puppeteer',
        prompt: payload[`slide_${i}_headline_html`] ?? payload[`slide_${i}_hook`] ?? payload[`slide_${i}_body_html`] ?? '',
        costKopecks: 0,
        durationMs: Date.now() - slideStarted,
        bytes: jpg.length,
        ...(input.painTag ? { painTag: input.painTag } : {}),
        status: 'ok',
      });

      rendered.push({
        index: i,
        url: uploaded.url,
        source: uploaded.source,
        publicId: uploaded.publicId,
        bytes: jpg.length,
        durationMs: Date.now() - slideStarted,
      });

      log.info(
        {
          contentPackageId: input.contentPackageId,
          slideIndex: i,
          url: uploaded.url,
          bytes: jpg.length,
          durationMs: Date.now() - slideStarted,
        },
        'html-renderer: slide rendered',
      );
    }
  } finally {
    await browser.close();
    await rm(tmpDir, { recursive: true, force: true });
  }

  const totalDurationMs = Date.now() - started;
  log.info(
    {
      contentPackageId: input.contentPackageId,
      ideaId: input.ideaId,
      slidesRendered: rendered.length,
      templateName,
      totalDurationMs,
    },
    'html-renderer: done',
  );

  return {
    slides: rendered,
    templateName,
    totalDurationMs,
    payloadCostUsd: 0, // payload sonnet stoit ~$0.01 — фиксированно посчитаем позже
  };
}
