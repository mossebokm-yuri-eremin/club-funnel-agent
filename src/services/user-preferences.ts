// user-preferences — read/write для /style команды в боте.
// SPEC: Phase 7, Правка 5. По умолчанию 'short'.

import type { Pool } from 'pg';
import { log } from '../observability/logger.js';

export type ContentStyle = 'short' | 'normal' | 'detailed';
export const DEFAULT_STYLE: ContentStyle = 'short';
export const VALID_STYLES: readonly ContentStyle[] = ['short', 'normal', 'detailed'];

export function isValidStyle(s: string): s is ContentStyle {
  return (VALID_STYLES as readonly string[]).includes(s);
}

export async function getUserStyle(pool: Pool, tgUserId: number): Promise<ContentStyle> {
  try {
    const r = await pool.query<{ content_style: ContentStyle }>(
      `SELECT content_style FROM user_preferences WHERE tg_user_id = $1`,
      [tgUserId],
    );
    return r.rows[0]?.content_style ?? DEFAULT_STYLE;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'user-preferences: getUserStyle failed → default');
    return DEFAULT_STYLE;
  }
}

export async function setUserStyle(
  pool: Pool,
  tgUserId: number,
  style: ContentStyle,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_preferences (tg_user_id, content_style)
       VALUES ($1, $2)
     ON CONFLICT (tg_user_id)
       DO UPDATE SET content_style = EXCLUDED.content_style, updated_at = NOW()`,
    [tgUserId, style],
  );
}

/** Текстовые инструкции по длине артефактов — встраиваются в user-prompt content-gen. */
export function styleInstructions(style: ContentStyle): {
  reelMaxWords: number;
  tgPostMinWords: number;
  tgPostMaxWords: number;
  slideMode: string;
  promptHint: string;
} {
  switch (style) {
    case 'detailed':
      return {
        reelMaxWords: 150,
        tgPostMinWords: 500,
        tgPostMaxWords: 800,
        slideMode: '2–3 предложения на слайд, разворачивай мысль',
        promptHint:
          'Стиль DETAILED: подробно, раскрытие мысли. TG пост 500–800 слов. Reels описание до 150 слов. Слайды карусели — 2–3 предложения каждый.',
      };
    case 'normal':
      return {
        reelMaxWords: 100,
        tgPostMinWords: 300,
        tgPostMaxWords: 500,
        slideMode: '1–2 предложения на слайд',
        promptHint:
          'Стиль NORMAL: средняя длина. TG пост 300–500 слов. Reels описание 80–100 слов. Слайды карусели — 1–2 предложения каждый.',
      };
    case 'short':
    default:
      return {
        reelMaxWords: 80,
        tgPostMinWords: 150,
        tgPostMaxWords: 250,
        slideMode: '1 короткое предложение на слайд (≤ 120 символов)',
        promptHint:
          'Стиль SHORT: коротко, плотно, без воды. TG пост 150–250 слов. Reels описание 60–80 слов. Слайды карусели — одно короткое предложение каждый, до 120 символов.',
      };
  }
}
