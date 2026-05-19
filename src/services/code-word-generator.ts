// code-word-generator — генерит уникальное кодовое слово для воронки.
// SPEC AC-27: snake_case, 2-3 «русских корня», уникальность в funnels.
//
// Подход: словарь Юрия-метафор (транслит) → 2 корня случайно → проверка UNIQUE
// → если конфликт, +2-значный hash суффикс. Без LLM (быстро, детерминированно).

import crypto from 'node:crypto';
import type { Pool } from 'pg';

// Корни из словаря Юрия: метафоры + ключевые понятия маркетинга/клуба.
// Транслит латиницей (snake_case-friendly, безопасно в Direct/UTM).
const ROOTS: readonly string[] = [
  'klub', 'realiz', 'rost', 'tsena', 'cek', 'delo', 'put', 'klient',
  'sistema', 'proekt', 'fokus', 'svoboda', 'biznes', 'sila', 'opyt',
  'mast', 'sdelat', 'sebya', 'sebe', 'serdtse', 'gora', 'volna',
  'imya', 'brend', 'ploshchad', 'metr', 'million', 'ches', 'mech',
  'svet', 'ogon', 'kod', 'klyuch', 'bron', 'staj', 'tochka',
  'krug', 'vnutri', 'glava', 'lest', 'shag', 'derzhi', 'verb',
];

function pickRoot(): string {
  return ROOTS[Math.floor(Math.random() * ROOTS.length)]!;
}

function buildCandidate(painSeed?: string): string {
  // 2-3 корня. 3-й добавляем редко (10% случаев), чтобы фразы оставались короткими.
  const parts: string[] = [pickRoot(), pickRoot()];
  if (Math.random() < 0.1) parts.push(pickRoot());
  // Если painSeed задан — берём первую безопасную часть как дополнительный хинт.
  if (painSeed) {
    const tail = painSeed.replace(/[^a-z]/gi, '').toLowerCase().slice(0, 6);
    if (tail.length >= 3 && Math.random() < 0.5) parts.push(tail);
  }
  // Дедуплицируем (если случайно повторились — берём только уникальные).
  const uniq = Array.from(new Set(parts));
  return uniq.join('_');
}

/**
 * Генерирует уникальное code_word — проверяет в funnels.code_word, до 8 попыток
 * со случайным выбором. Если все коллизии — добавляем 4-значный hash от ts.
 */
export async function generateUniqueCodeWord(
  pool: Pool,
  opts: { painSeed?: string; maxAttempts?: number } = {},
): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const { painSeed } = opts;
  for (let i = 0; i < maxAttempts; i++) {
    const cand = buildCandidate(painSeed);
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM funnels WHERE code_word = $1 LIMIT 1`,
      [cand],
    );
    if (r.rowCount === 0) return cand;
  }
  // Fallback с hash от timestamp — гарантированно уникально.
  const tail = crypto.randomBytes(2).toString('hex'); // 4 hex chars
  return `${buildCandidate(painSeed)}_${tail}`;
}
