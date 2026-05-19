// text-overlay — наносит русский текст слайда поверх AI-картинки от Seedream.
//
// Seedream-4 плохо умеет кириллицу. Стратегия:
//   1. Seedream рендерит «фон» — premium editorial visual без текста.
//   2. Sharp resize+crop под 1080×1350.
//   3. Sharp composite поверх SVG-оверлей с русским текстом + drop-shadow +
//      brand-плашка снизу (@yury_eremin · клуб «Реализация»).
//
// SVG читает встроенные системные fonts (sans-serif fallback). На VPS установлен
// fonts-inter (см. install-script Phase 0) — Inter рендерится правильно.

import sharp from 'sharp';
import { log } from '../observability/logger.js';

export type OverlayPosition = 'top' | 'bottom' | 'center';

export interface TextOverlayInput {
  /** Сырая картинка от AI (PNG/JPG, любого размера). */
  imageBuffer: Buffer;
  /** Русский текст слайда (1-3 предложения). */
  text: string;
  /** Номер слайда (1-based). */
  slideIndex: number;
  /** Всего слайдов. */
  totalSlides: number;
  /** Тег боли (для kicker'а сверху). */
  painTag?: string;
  /** Где разместить текст. Default: cover → top, cta → center, body → bottom. */
  position?: OverlayPosition;
}

export interface TextOverlayOutput {
  /** Финальный JPG 1080×1350. */
  jpg: Buffer;
  bytes: number;
  width: number;
  height: number;
}

const TARGET_W = 1080;
const TARGET_H = 1350;

/** XML/HTML escape — текст идёт в foreignObject (xhtml div). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Auto font-size по длине текста — чтобы не вылезало за canvas. */
function pickFontSize(text: string, position: OverlayPosition): number {
  const len = text.length;
  // Cover (top) — крупно, до 90px. Body (bottom) — средне, до 64px. Center — средне.
  if (position === 'top') {
    if (len > 180) return 56;
    if (len > 120) return 68;
    if (len > 60) return 80;
    return 92;
  }
  if (position === 'center') {
    if (len > 180) return 50;
    if (len > 120) return 62;
    if (len > 60) return 72;
    return 84;
  }
  // bottom
  if (len > 240) return 38;
  if (len > 160) return 46;
  if (len > 80) return 54;
  return 62;
}

function autoPosition(slideIndex: number, totalSlides: number): OverlayPosition {
  if (slideIndex === 1) return 'top';
  if (slideIndex >= totalSlides) return 'center';
  return 'bottom';
}

/** Строит SVG-оверлей с текстом + плашкой бренда. Размер всегда 1080×1350. */
function buildOverlaySvg(input: {
  text: string;
  position: OverlayPosition;
  fontSize: number;
  kicker: string | null;
  slideIndex: number;
  totalSlides: number;
}): string {
  const text = escapeXml(input.text);
  const kicker = input.kicker ? escapeXml(input.kicker.toUpperCase().slice(0, 32)) : '';
  // Безопасные зоны: top 80-460 (cover), center 380-980 (cta), bottom 800-1280 (body).
  let textY: number;
  let textH: number;
  let textAlign: 'left' | 'center' = 'left';
  let scrim: { y: number; h: number; from: number; to: number };
  switch (input.position) {
    case 'top':
      textY = 100;
      textH = 480;
      scrim = { y: 0, h: 600, from: 0.65, to: 0 };
      break;
    case 'center':
      textY = 380;
      textH = 600;
      textAlign = 'center';
      scrim = { y: 280, h: 700, from: 0, to: 0.55 };
      break;
    case 'bottom':
    default:
      textY = 800;
      textH = 460;
      scrim = { y: 700, h: 580, from: 0, to: 0.7 };
      break;
  }

  // Полупрозрачный градиент-тень под текстом — гарантирует контраст на любой картинке.
  const scrimSvg = `
    <defs>
      <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(0,0,0,${scrim.from})"/>
        <stop offset="100%" stop-color="rgba(0,0,0,${scrim.to})"/>
      </linearGradient>
    </defs>
    <rect x="0" y="${scrim.y}" width="${TARGET_W}" height="${scrim.h}" fill="url(#scrim)"/>`;

  const kickerSvg = kicker
    ? `<text x="80" y="${textY - 30}"
            font-family="Inter, -apple-system, 'SF Pro Display', sans-serif"
            font-weight="700" font-size="22" fill="#ff7518" letter-spacing="3"
            paint-order="stroke" stroke="rgba(0,0,0,0.4)" stroke-width="0.5">${kicker}</text>`
    : '';

  // foreignObject + xhtml div — единственный надёжный word-wrap для long кириллицы.
  // text-align зависит от позиции (cover left, center centered, body left).
  const overlayText = `
    <foreignObject x="80" y="${textY}" width="${TARGET_W - 160}" height="${textH}">
      <div xmlns="http://www.w3.org/1999/xhtml"
           style="
             font-family: Inter, -apple-system, 'SF Pro Display', sans-serif;
             font-weight: 700;
             font-size: ${input.fontSize}px;
             line-height: 1.12;
             letter-spacing: -0.01em;
             color: #ffffff;
             text-shadow: 0 2px 16px rgba(0,0,0,0.55), 0 0 2px rgba(0,0,0,0.8);
             word-wrap: break-word;
             white-space: pre-wrap;
             text-align: ${textAlign};
           ">${text}</div>
    </foreignObject>`;

  // Низ: brand-плашка + индикатор слайда.
  const brandBar = `
    <rect x="0" y="${TARGET_H - 60}" width="${TARGET_W}" height="60" fill="rgba(44,40,38,0.85)"/>
    <text x="80" y="${TARGET_H - 22}"
          font-family="Inter, -apple-system, sans-serif"
          font-weight="600" font-size="22" fill="#dfdbd8">@yury_eremin · клуб «Реализация»</text>
    <text x="${TARGET_W - 80}" y="${TARGET_H - 22}" text-anchor="end"
          font-family="Inter, -apple-system, sans-serif"
          font-weight="600" font-size="22" fill="#ff7518">${input.slideIndex
    .toString()
    .padStart(2, '0')} / ${input.totalSlides.toString().padStart(2, '0')}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_W}" height="${TARGET_H}"
     viewBox="0 0 ${TARGET_W} ${TARGET_H}">
  ${scrimSvg}
  ${kickerSvg}
  ${overlayText}
  ${brandBar}
</svg>`;
}

/**
 * Основная функция: resize+crop картинку под 1080×1350, накладывает SVG-оверлей,
 * сохраняет цветокоррекцию (контраст +5%, saturation -3% — как в image-composer).
 */
export async function overlayTextOnImage(
  input: TextOverlayInput,
): Promise<TextOverlayOutput> {
  const position = input.position ?? autoPosition(input.slideIndex, input.totalSlides);
  const fontSize = pickFontSize(input.text, position);

  // 1) Resize + crop input до 1080×1350.
  const base = await sharp(input.imageBuffer)
    .resize(TARGET_W, TARGET_H, { fit: 'cover', position: 'attention' })
    // Лёгкая цветокоррекция — приводит к brand-style: +5% контраст, -3% saturation.
    .linear(1.05, -6.4)
    .modulate({ saturation: 0.97 })
    .png()
    .toBuffer();

  // 2) Build SVG overlay.
  const svg = buildOverlaySvg({
    text: input.text,
    position,
    fontSize,
    kicker: input.painTag ?? null,
    slideIndex: input.slideIndex,
    totalSlides: input.totalSlides,
  });

  // 3) Composite: base + svg.
  const jpg = await sharp(base)
    .composite([{ input: Buffer.from(svg, 'utf8'), top: 0, left: 0 }])
    .jpeg({ quality: 90, progressive: true, mozjpeg: true })
    .toBuffer();

  log.info(
    {
      slideIndex: input.slideIndex,
      totalSlides: input.totalSlides,
      position,
      fontSize,
      textLen: input.text.length,
      bytes: jpg.length,
    },
    'text-overlay: composed',
  );

  return {
    jpg,
    bytes: jpg.length,
    width: TARGET_W,
    height: TARGET_H,
  };
}
