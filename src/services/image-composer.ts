// image-composer — пост-обработка изображений каруселей (SPEC AC-20).
//
// 1. Автокроп до 1080×1350 (Instagram 4:5).
// 2. Цветокоррекция: контраст +5%, насыщенность −3%.
// 3. Вотермарк @yury_eremin в нижнем правом углу 24px.
//
// Используем sharp (libvips bindings). Стрингифицируем шаги через цепочку sharp().

import sharp from 'sharp';
import { log } from '../observability/logger.js';

export interface ComposeInput {
  /** Сырой PNG (любого размера / соотношения), приходит от Nano Banana. */
  png: Buffer;
  /** Текст вотермарка. По умолчанию '@yury_eremin'. */
  watermarkText?: string;
  /** Размер шрифта вотермарка в px. SPEC AC-20: 24px. */
  watermarkFontPx?: number;
}

export interface ComposeOutput {
  /** Финальный JPG 1080×1350 с вотермарком (SPEC AC-21 — «Готовые JPG»). */
  jpg: Buffer;
  /** Метаданные результата (для логов / тестов). */
  meta: {
    width: number;
    height: number;
    bytes: number;
  };
}

const TARGET_W = 1080;
const TARGET_H = 1350;

function buildWatermarkSvg(text: string, fontPx: number): Buffer {
  // SVG-вотермарк белой полупрозрачной заливкой с тонкой тёмной обводкой.
  // Размещаем правее центра, чтобы выровнять по нижнему правому углу при composite.
  const padding = 32;
  const svgW = 360;
  const svgH = fontPx + padding * 2;
  const xText = svgW - padding;
  const yText = fontPx + padding;
  const svg = `
    <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
      <style>
        .wm { font-family: -apple-system, Inter, sans-serif; font-size: ${fontPx}px;
              font-weight: 600; fill: rgba(255,255,255,0.95);
              stroke: rgba(0,0,0,0.6); stroke-width: 1; paint-order: stroke; }
      </style>
      <text class="wm" x="${xText}" y="${yText}" text-anchor="end">${escapeXml(text)}</text>
    </svg>
  `;
  return Buffer.from(svg);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return c;
    }
  });
}

export async function composeSlide(input: ComposeInput): Promise<ComposeOutput> {
  const watermarkText = input.watermarkText ?? '@yury_eremin';
  const fontPx = input.watermarkFontPx ?? 24;

  // 1) Автокроп с сохранением центра до 1080×1350.
  // sharp.resize с fit='cover' + position='attention' даёт умный кадр.
  const baseBuf = await sharp(input.png)
    .resize(TARGET_W, TARGET_H, { fit: 'cover', position: 'attention' })
    // 2) Цветокоррекция: контраст +5%, насыщенность −3%.
    // Контраст pixel * a + b. Чтобы серая середина (128) осталась серой: b = 128·(1-a).
    // Для a=1.05 → b = 128·(-0.05) = -6.4.
    .linear(1.05, -6.4)
    .modulate({ saturation: 0.97 })
    .jpeg({ quality: 88, progressive: true, mozjpeg: true })
    .toBuffer();

  // 3) Вотермарк @yury_eremin 24px в правом нижнем углу.
  const wmSvg = buildWatermarkSvg(watermarkText, fontPx);
  const finalBuf = await sharp(baseBuf)
    .composite([
      {
        input: wmSvg,
        gravity: 'southeast',
      },
    ])
    .jpeg({ quality: 88, progressive: true, mozjpeg: true })
    .toBuffer();

  const meta = await sharp(finalBuf).metadata();
  const result: ComposeOutput = {
    jpg: finalBuf,
    meta: {
      width: meta.width ?? TARGET_W,
      height: meta.height ?? TARGET_H,
      bytes: finalBuf.length,
    },
  };

  log.info(
    { width: result.meta.width, height: result.meta.height, bytes: result.meta.bytes },
    'image-composer: slide ready',
  );
  return result;
}
