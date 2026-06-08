// ig-caption-generator — генерит подпись для поста в Instagram через Sonnet 4.6.
//
// ТЗ Юрия 2026-06-08: переключён с twin-ye.v2 на новый buildTwinYePrompt с
// kind='ig_caption'. Это даёт:
//   - запрет эмодзи в основном тексте (только в строке хештегов)
//   - длина 200-400 слов через valid-v3
//   - обязательно имя из real_stories + ≥4 характерных оборота
//   - органичная интеграция code_word в финальный CTA
//
// Без MOSSEBO. Без цены клуба (sacred rule #11).

import type { Pool } from 'pg';
import { callAnthropic } from '../integrations/anthropic.js';
import { buildTwinYePrompt } from '../prompts/twin-ye.js';
import { log } from '../observability/logger.js';

const STRATEGY_DESC: Record<'A' | 'B' | 'C', string> = {
  A: 'дать бесплатный лонгрид как лид-магнит (потом продавать клуб)',
  B: 'пригласить в Telegram-канал клуба «Реализация» напрямую',
  C: 'дать бесплатный лонгрид + предложить курс/наставничество',
};

export interface IgCaptionInput {
  /** Pool обязателен для buildTwinYePrompt (читает yury_voice_samples + voice-analysis). */
  pool: Pool;
  ideaSummary: string;
  painTag: string;
  strategy: 'A' | 'B' | 'C';
  codeWord: string;
  bonusTitle?: string;
}

export interface IgCaptionResult {
  caption: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export async function generateIgCaption(input: IgCaptionInput): Promise<IgCaptionResult> {
  const codeUpper = input.codeWord.toUpperCase();
  const ctaTarget =
    input.strategy === 'B'
      ? 'TG-канал клуба «Реализация»'
      : input.bonusTitle
        ? `лонгрид «${input.bonusTitle}»`
        : 'материалы и приглашение в клуб';

  // Новый промпт: kind='ig_caption' → встроенные требования (длина 200+, ≥4 оборота,
  // имя из real_stories, БЕЗ эмодзи в основном тексте, хештеги отдельной строкой).
  const built = await buildTwinYePrompt(input.pool, {
    ideaText: input.ideaSummary,
    codeWord: input.codeWord,
    kind: 'ig_caption',
  });

  const userMsg = [
    `Тема карусели: ${input.ideaSummary}`,
    `Боль ЦА: ${input.painTag}`,
    `Стратегия воронки: ${STRATEGY_DESC[input.strategy]}`,
    `Code_word для CTA (в UPPERCASE): ${codeUpper}`,
    `Куда ведём подписчика: ${ctaTarget}`,
    '',
    'Напиши caption по 7-блочной структуре (см. требования к ig_caption выше).',
    'Code_word — ОБЯЗАТЕЛЬНО в финальном CTA Блока 6 органично.',
    'Эмодзи — ТОЛЬКО в финальной строке хештегов (Блок 7), не в Блоках 1–6.',
  ].join('\n');

  const startedAt = Date.now();
  const r = await callAnthropic({
    mode: 'generative',
    system: built.systemPrompt,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: 1500,
    temperature: 0.85,
    traceTag: 'ig-caption',
  });

  const caption = r.text.trim();
  // Подстраховка: если LLM забыл вставить code_word — добавляем явный CTA.
  const needsFallback = !caption.includes(codeUpper);
  const finalCaption = needsFallback
    ? caption +
      '\n\nЕсли хочешь разобрать — напиши ' + codeUpper + ' в Direct. Пришлю ' +
      (input.strategy === 'B' ? 'ссылку на канал клуба «Реализация».' : 'материалы.')
    : caption;

  log.info(
    {
      codeWord: input.codeWord,
      strategy: input.strategy,
      chars: finalCaption.length,
      promptTokens: r.usage.input_tokens,
      completionTokens: r.usage.output_tokens,
      costUsd: r.costUsd,
      durationMs: Date.now() - startedAt,
      fallback: needsFallback,
    },
    'ig-caption: generated',
  );

  return {
    caption: finalCaption,
    promptTokens: r.usage.input_tokens,
    completionTokens: r.usage.output_tokens,
    costUsd: r.costUsd,
  };
}

const IG_SHORTCODE_RE = /(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/** Извлекает shortcode из URL Instagram. Возвращает null если не Instagram. */
export function extractIgShortcode(url: string): string | null {
  const m = url.match(IG_SHORTCODE_RE);
  return m?.[1] ?? null;
}
