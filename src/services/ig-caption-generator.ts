// ig-caption-generator — генерит подпись для поста в Instagram через Sonnet 4.6.
//
// Вход: idea (summary + pain_tag + strategy) + codeWord + опц. bonusTitle.
// Выход: caption 600–1200 символов с hook + телом + CTA "Пиши «CODEWORD» в Direct" + 5–7 хештегов.
//
// Без MOSSEBO. Без конкретной цены клуба (sacred rule #11).
// Голос — Юрий Еремин: первое лицо, тёплый, без штампов.

import { callAnthropic } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

const STRATEGY_DESC: Record<'A' | 'B' | 'C', string> = {
  A: 'дать бесплатный лонгрид как лид-магнит (потом продавать клуб)',
  B: 'пригласить в Telegram-канал клуба «Реализация» напрямую',
  C: 'дать бесплатный лонгрид + предложить курс/наставничество',
};

export interface IgCaptionInput {
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

  const system = [
    'Ты — копирайтер Юрия Еремина (дизайнер интерьеров с 17+ лет опыта, основатель клуба «Реализация» для дизайнеров).',
    'Пишешь подпись для поста в Instagram под карусель.',
    '',
    'СТРОГИЕ ПРАВИЛА:',
    '- Голос: первое лицо («я», «у меня»), тёплый, спокойный, без хайпа.',
    '- Объём: 600–1200 символов (вписаться в Instagram, не растянуто).',
    '- Структура: 1) hook (2–3 строки) → 2) тело раскрывает идею → 3) CTA с code_word → 4) хештеги.',
    '- В конце ОБЯЗАТЕЛЬНО: «Пиши <CODE_WORD> в Direct — пришлю …» (точная фраза с code_word в UPPERCASE).',
    '- Хештеги: 5–7 релевантных тематике (дизайн интерьеров, бизнес для дизайнеров). НЕ общие типа #love, #life.',
    '- НЕ упоминай конкретную цену клуба, рублей, «5000», «5К», «пять тысяч», «5 000 ₽».',
    '- НЕ используй штампы: «уникальное предложение», «не пропусти», «лимитированно», «успей».',
    '- НЕ ставь эмодзи в каждой строке — 2–4 на весь пост максимум.',
    '- НЕ MOSSEBO, не упоминай прошлые сети Юрия.',
    '',
    'Верни ТОЛЬКО подпись (без преамбулы, без «Вот подпись:»). Хештеги в самом конце через пробел.',
  ].join('\n');

  const userMsg = [
    `Тема карусели: ${input.ideaSummary}`,
    `Боль ЦА: ${input.painTag}`,
    `Стратегия: ${STRATEGY_DESC[input.strategy]}`,
    `Code_word для CTA (в UPPERCASE): ${codeUpper}`,
    `Куда ведём подписчика: ${ctaTarget}`,
    '',
    'Напиши подпись.',
  ].join('\n');

  const startedAt = Date.now();
  const r = await callAnthropic({
    mode: 'generative',
    system,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: 1500,
    temperature: 0.7,
    traceTag: 'ig-caption',
  });

  const caption = r.text.trim();
  // Подстраховка: если LLM забыл вставить code_word — добавляем явный CTA.
  const needsFallback = !caption.includes(codeUpper);
  const finalCaption = needsFallback
    ? caption +
      '\n\n' +
      `Пиши «${codeUpper}» в Direct — пришлю ${input.strategy === 'B' ? 'ссылку на канал клуба' : 'материалы'}.`
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
