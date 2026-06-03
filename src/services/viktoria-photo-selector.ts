// viktoria-photo-selector — выбор фото Виктории для подмены лица героини
// на эталонных слайдах с face_role='woman-30-40'.
//
// Реестр скачан из GDrive 02-viktoriya-photos (scripts/download-portraits.ts).
// HEIC скипнут — nano-banana-2 принимает только JPEG/PNG URL.

import { config } from '../config.js';

export interface SelectViktoriaPhotoInput {
  slideIndex: number;
  totalSlides: number;
  slideText: string;
  background?: string | null;
}

interface Photo {
  filename: string;
  category: 'portrait' | 'smile';
}

const PHOTO_REGISTRY: Photo[] = [
  { filename: 'viktoriya-portrait-01.jpg', category: 'portrait' },
  { filename: 'viktoriya-portrait-02.jpg', category: 'portrait' },
  { filename: 'viktoriya-smile-02.jpg', category: 'smile' },
];

const PHOTO_BASE_URL = (() => {
  const base = config.APP_PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
  return `${base}/cdn/viktoriya-photos`;
})();

function pickByCategory(category: Photo['category']): Photo | null {
  const candidates = PHOTO_REGISTRY.filter((p) => p.category === category);
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

export function selectViktoriaPhotoUrl(input: SelectViktoriaPhotoInput): string {
  const { slideIndex, totalSlides, slideText } = input;
  const lower = (slideText ?? '').toLowerCase();
  const isCover = slideIndex === 1;
  const isCta = slideIndex === totalSlides && totalSlides > 1;

  let chosen: Photo | null = null;
  if (isCover || isCta) chosen = pickByCategory('portrait');
  if (!chosen) {
    if (/радост|улыб|горжус|кейс|истори|получилось/iu.test(lower)) {
      chosen = pickByCategory('smile');
    } else {
      chosen = pickByCategory('portrait');
    }
  }
  if (!chosen) chosen = PHOTO_REGISTRY[0] ?? null;
  if (!chosen) throw new Error('viktoria-photo-selector: registry empty');
  return `${PHOTO_BASE_URL}/${chosen.filename}`;
}

export function viktoriaPhotoRegistrySize(): number {
  return PHOTO_REGISTRY.length;
}
