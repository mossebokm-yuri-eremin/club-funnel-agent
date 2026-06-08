// code-word-generator — ОДНО русское слово через LLM (Sonnet 4.6).
//
// SPEC AC-27 + ТЗ Юрия 2026-06-08:
//   - ОДНО русское слово ЗАГЛАВНЫМИ (КЛУБ, АННА, ЧЕК, БРЕНД)
//   - 4-10 букв
//   - Простое для произношения и набора в IG Direct
//   - Связано с темой идеи или с клубом «Реализация»
//   - Можно с цифрой в конце (КЛУБ2026)
//   - НЕТ латинизированных аббревиатур типа ROST_STAJ_METR
//   - НЕТ подчёркиваний
//   - Уникальность в funnels.code_word — при коллизии дописываем 2-значное число
//
// Хранится в БД нижним регистром (для URL-friendly), отображается КАПСОМ.

import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { callAnthropic } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

const SYSTEM_PROMPT = `Ты генератор кодовых слов для воронки Instagram → Direct → клуб «Реализация».

ЗАДАЧА: дать ОДНО русское слово ЗАГЛАВНЫМИ буквами для кодового слова воронки.

ТРЕБОВАНИЯ:
- ОДНО русское слово (или одно слово + одна цифра)
- 4-10 букв (без учёта цифр)
- Только КИРИЛЛИЦА (никакой латиницы!)
- Простое для произношения и набора в Direct
- Связано с темой поста или с клубом «Реализация»
- Можно добавить цифру в конце (КЛУБ2026, ЧЕК2)
- ЗАГЛАВНЫМИ буквами

ПРИМЕРЫ ХОРОШИХ:
- Тема «рост чека» → ЧЕК / РОСТ / МЕТР / 8000
- Тема «экспертность» → КОРОЧКА / ЭКСПЕРТ
- Тема «позиционирование» → БРЕНД / ПОЗИЦИЯ
- Тема «Анна Кацапова» → АННА / 8000
- Тема «авторский надзор» → НАДЗОР / ПОЗИЦИЯ
- Тема «синдром самозванца» → КОРОЧКА / РАЗРЕШЕНИЕ
- Универсальное → КЛУБ / РЕАЛИЗАЦИЯ

ЗАПРЕЩЕНО:
- Транслит русских слов латиницей (ROST, STAJ, KLUB латиницей)
- Аббревиатуры через подчёркивание (ROST_STAJ_METR)
- Несколько слов через _ или -
- Английские слова
- Цифры без слова (просто 2026)
- Datestamp форматы (klub-2026-05-21-a1)

ВЫХОД: ТОЛЬКО кодовое слово, без объяснений, без кавычек, без точек.`;

function buildUserPrompt(painSeed: string | undefined, ideaSummary: string | undefined): string {
  const parts: string[] = [];
  if (ideaSummary) parts.push(`Тема: "${ideaSummary}"`);
  if (painSeed) parts.push(`Боль: "${painSeed}"`);
  if (parts.length === 0) parts.push('Универсальное приглашение в клуб «Реализация»');
  parts.push('\nКодовое слово (ОДНО русское слово ЗАГЛАВНЫМИ, 4-10 букв):');
  return parts.join('\n');
}

const CYRILLIC_ONLY = /^[А-ЯЁ]{4,10}\d{0,4}$/u;

function validateCandidate(raw: string): { ok: true; cleaned: string } | { ok: false; reason: string } {
  const cleaned = raw.trim().toUpperCase().replace(/[«»"'`.,!?:;()]/g, '');
  if (!cleaned) return { ok: false, reason: 'empty' };
  if (cleaned.length > 14) return { ok: false, reason: `too long (${cleaned.length} chars)` };
  if (cleaned.length < 4) return { ok: false, reason: `too short (${cleaned.length} chars)` };
  if (cleaned.includes('_') || cleaned.includes('-') || cleaned.includes(' ')) {
    return { ok: false, reason: 'contains _ or - or space' };
  }
  if (/[A-Za-z]/.test(cleaned)) return { ok: false, reason: 'contains latin' };
  if (!CYRILLIC_ONLY.test(cleaned)) return { ok: false, reason: `pattern mismatch: "${cleaned}"` };
  return { ok: true, cleaned };
}

async function generateOne(painSeed: string | undefined, ideaSummary: string | undefined): Promise<string | null> {
  const r = await callAnthropic({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(painSeed, ideaSummary) }],
    mode: 'generative',
    maxTokens: 60,
    temperature: 0.8,
    traceTag: 'code-word-gen',
  });
  const text = r.text?.trim() ?? '';
  // Сонет иногда даёт "Кодовое слово: АННА" — берём последнее слово
  const lastToken = text.split(/[\s\n:]+/).filter(Boolean).pop() ?? '';
  return lastToken || null;
}

/**
 * Генерирует ОДНО русское кодовое слово через Sonnet 4.6, валидирует и проверяет
 * уникальность в funnels.code_word. До 5 попыток; при коллизии или невалидном
 * ответе дописывает 2-значное число.
 *
 * @returns code_word в **нижнем регистре** (для URL/БД). Для отображения используй .toUpperCase().
 */
export async function generateUniqueCodeWord(
  pool: Pool,
  opts: { painSeed?: string; ideaSummary?: string; maxAttempts?: number } = {},
): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastCleaned: string | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    let cand: string | null;
    try {
      cand = await generateOne(opts.painSeed, opts.ideaSummary);
    } catch (err) {
      log.warn({ err: (err as Error).message, attempt: i + 1 }, 'code-word: LLM call failed');
      continue;
    }
    if (!cand) continue;
    const v = validateCandidate(cand);
    if (!v.ok) {
      log.warn({ raw: cand, reason: v.reason, attempt: i + 1 }, 'code-word: invalid candidate');
      continue;
    }
    lastCleaned = v.cleaned;
    // Уникальность (lower-case в БД)
    const lower = v.cleaned.toLowerCase();
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM funnels WHERE code_word = $1 LIMIT 1`,
      [lower],
    );
    if (r.rowCount === 0) {
      log.info({ codeWord: lower, attempts: i + 1 }, 'code-word: generated');
      return lower;
    }
    log.info({ codeWord: lower, attempt: i + 1 }, 'code-word: collision, retrying');
  }

  // Fallback: берём последний валидный + 2 цифры hash
  if (lastCleaned) {
    const tail = parseInt(crypto.randomBytes(1).toString('hex'), 16) % 90 + 10; // 10..99
    const lower = (lastCleaned + tail).toLowerCase();
    log.warn({ codeWord: lower }, 'code-word: fallback with digit suffix');
    return lower;
  }

  // Совсем fallback на статическое слово + цифры
  const fallback = 'клуб' + (Math.floor(Math.random() * 90) + 10);
  log.error({ codeWord: fallback }, 'code-word: complete fallback after all LLM failures');
  return fallback;
}
