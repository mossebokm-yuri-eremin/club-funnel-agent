// winning-patterns — извлекает успешные структуры из уже одобренных
// content_packages (approval_status='approved') и форматирует как few-shot
// для content-gen. Подразумеваем: одобренное Юрием = эталон голоса/структуры.

import type { Pool } from 'pg';
import { log } from '../observability/logger.js';

export interface WinningPattern {
  packageId: string;
  paintag: string | null;
  reelOpening: string;  // первые ~200 символов рилса
  tgOpening: string;    // первые ~200 символов tg-поста
  createdAt: string;
}

/**
 * Берёт last N одобренных пакетов по той же боли (если задан pain) или вообще.
 * Возвращает открывающие фразы — то, что цепляет читателя.
 */
export async function getLastWinningPatterns(
  pool: Pool,
  opts: { pain?: string | null; limit?: number } = {},
): Promise<WinningPattern[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 3, 10));
  // 1) Пытаемся найти одобренное по той же боли.
  let r;
  if (opts.pain) {
    r = await pool.query<{
      id: string;
      pain_tag: string | null;
      reel_caption: string;
      tg_post: string;
      created_at: Date;
    }>(
      `SELECT cp.id, i.pain_tag, cp.reel_caption, cp.tg_post, cp.created_at
         FROM content_packages cp
         JOIN ideas i ON i.id = cp.idea_id
        WHERE cp.approval_status = 'approved'
          AND i.pain_tag = $1
        ORDER BY cp.created_at DESC
        LIMIT $2`,
      [opts.pain, limit],
    );
  } else {
    r = await pool.query<{
      id: string;
      pain_tag: string | null;
      reel_caption: string;
      tg_post: string;
      created_at: Date;
    }>(
      `SELECT cp.id, i.pain_tag, cp.reel_caption, cp.tg_post, cp.created_at
         FROM content_packages cp
         JOIN ideas i ON i.id = cp.idea_id
        WHERE cp.approval_status = 'approved'
        ORDER BY cp.created_at DESC
        LIMIT $1`,
      [limit],
    );
  }

  // 2) Если по конкретной боли пусто — возьмём любые одобренные.
  if (r.rows.length === 0 && opts.pain) {
    return getLastWinningPatterns(pool, { limit });
  }

  return r.rows.map((row) => ({
    packageId: row.id,
    paintag: row.pain_tag,
    reelOpening: (row.reel_caption ?? '').slice(0, 200),
    tgOpening: (row.tg_post ?? '').slice(0, 200),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }));
}

/** Форматирует patterns для встраивания в user-prompt content-gen. */
export function formatWinningPatterns(patterns: WinningPattern[], maxChars = 1500): string {
  if (patterns.length === 0) return '';
  const lines: string[] = [
    'ПРЕДЫДУЩИЕ ОДОБРЕННЫЕ ПОСТЫ (структура и тон — эталон, не копируй дословно):',
  ];
  let total = 0;
  for (const p of patterns) {
    const block =
      `--- pkg ${p.packageId.slice(0, 8)} pain=${p.paintag ?? '—'} ---\n` +
      `[Reel-открытие]: ${p.reelOpening}\n` +
      `[TG-открытие]:   ${p.tgOpening}\n`;
    if (total + block.length > maxChars) break;
    lines.push(block);
    total += block.length;
  }
  log.debug({ count: patterns.length, totalChars: total }, 'winning-patterns: formatted');
  return lines.join('\n');
}
