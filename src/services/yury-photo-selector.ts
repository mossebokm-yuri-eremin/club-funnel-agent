// yury-photo-selector — выбор подходящего портрета Юрия для подмены лица на эталонном слайде.
//
// Phase 12 face-replacement: когда эталон содержит мужское лицо ~40-50 лет — это
// место для Юрия. nano-banana-2 принимает в images[] второй URL как референс
// идентичности (face swap).
//
// Папка /var/www/cdn/yury-photos/ раздаётся nginx'ом по https://agent.yury-eremin.ru/cdn/yury-photos/<file>.
// Маппер выбирает файл по контексту слайда. Файлы пока: fullsize-01.jpg (single MVP source).
// Когда Юрий зальёт остальные (strict-portrait-01..07, working-01..02, smile-01..03) —
// маппер сам начнёт варьировать выбор по контексту (cover/working/smile).
//
// API:
//   selectYuryPhotoUrl({ slideIndex, totalSlides, slideText, background })
//     → public URL of a portrait photo

import { config } from '../config.js';

export interface SelectYuryPhotoInput {
  slideIndex: number;
  totalSlides: number;
  slideText: string;
  /** From template_slide_analysis.background. */
  background?: string | null;
}

interface Photo {
  filename: string;
  category: 'strict' | 'working' | 'smile' | 'fullsize';
}

// Реестр доступных фото Юрия — скачано из GDrive 01-yuri-photos (см. scripts/download-portraits.ts).
const PHOTO_REGISTRY: Photo[] = [
  { filename: 'yuri-portrait-strict-01.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-02.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-03.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-04.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-05.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-06.jpg', category: 'strict' },
  { filename: 'yuri-portrait-strict-07.jpg', category: 'strict' },
  { filename: 'yuri-portrait-smile-01.jpg', category: 'smile' },
  { filename: 'yuri-portrait-smile-02.jpg', category: 'smile' },
  { filename: 'yuri-portrait-smile-03.jpg', category: 'smile' },
  { filename: 'yuri-working-01.jpg', category: 'working' },
  { filename: 'yuri-working-02.jpg', category: 'working' },
  { filename: 'yuri-fullsize-01.jpg', category: 'fullsize' },
  { filename: 'yuri-fullsize-02.jpg', category: 'fullsize' },
];

const PHOTO_BASE_URL = (() => {
  const base = config.APP_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}/cdn/yury-photos`;
})();

function pickByCategory(category: Photo['category']): Photo | null {
  const candidates = PHOTO_REGISTRY.filter((p) => p.category === category);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

function pickAny(): Photo {
  // Fallback. Гарантированно есть хотя бы fullsize-01 в реестре.
  const p = PHOTO_REGISTRY[0];
  if (!p) throw new Error('yury-photo-selector: PHOTO_REGISTRY is empty');
  return p;
}

/** Возвращает абсолютный URL подходящего фото Юрия. */
export function selectYuryPhotoUrl(input: SelectYuryPhotoInput): string {
  const { slideIndex, totalSlides, slideText, background } = input;
  const lower = (slideText ?? '').toLowerCase();
  const isCover = slideIndex === 1;
  const isCta = slideIndex === totalSlides && totalSlides > 1;

  let chosen: Photo | null = null;

  // 1) Cover / CTA — строгий портрет
  if (isCover || isCta) {
    chosen = pickByCategory('strict');
  }

  // 2) Body slides — по контексту текста
  if (!chosen) {
    if (/работ|проект|студи|клиент|чек/iu.test(lower) || background === 'office') {
      chosen = pickByCategory('working');
    } else if (/опыт|путь|истори|кейс|пример/iu.test(lower)) {
      chosen = pickByCategory('strict');
    } else if (/смех|улыб|радост|горжус|это уже происходит|поезд/iu.test(lower)) {
      chosen = pickByCategory('smile');
    }
  }

  // 3) Default — strict, иначе любой
  if (!chosen) chosen = pickByCategory('strict') ?? pickAny();

  return `${PHOTO_BASE_URL}/${chosen.filename}`;
}

/** Сколько уникальных фото доступно в реестре. */
export function yuryPhotoRegistrySize(): number {
  return PHOTO_REGISTRY.length;
}
