// ig-html-payload-generator — превращает 10 текстов слайдов content-worker
// в slot-data для HTML-шаблона yury-universal-v1 (placeholder заполнения).
//
// Вход: carousel_slides (string[]), idea, funnel.code_word + strategy.
// Выход: SlideData с keys {deck_*, slide_N_*, code_word_upper} строго под шаблон.
//
// Использует Sonnet 4.6: даёт ему 10 текстов + контекст + просит вернуть JSON
// с распределением по cover/body/cta slots. JSON schema enforced через prompt.

import { callAnthropic, parseJsonResponse } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

export interface PayloadInput {
  /** Тексты слайдов как написал content-worker. */
  slidesText: string[];
  /** Идея + контекст. */
  ideaSummary: string;
  painTag: string;
  strategy: 'A' | 'B' | 'C';
  /** Из funnel-activator. */
  codeWord: string;
  /** Опц. — заголовок лонгрида (для cover eyebrow). */
  bonusTitle?: string;
}

export type HtmlSlideData = Record<string, string>;

const STRATEGY_CTA: Record<'A' | 'B' | 'C', string> = {
  A: 'Пиши это слово в Direct — пришлю лонгрид целиком.',
  B: 'Пиши это слово в Direct — пришлю ссылку на канал клуба.',
  C: 'Пиши это слово в Direct — пришлю материалы и приглашение.',
};

export async function generateHtmlPayload(input: PayloadInput): Promise<HtmlSlideData> {
  if (input.slidesText.length === 0) {
    throw new Error('generateHtmlPayload: slidesText is empty');
  }

  // const total = input.slidesText.length; // unused
  const codeUpper = input.codeWord.toUpperCase();
  // Аккуратно укладываем 10 слайдов в 10 slots. Если меньше — циклим до 10 (cover/body/cta).
  // Для шаблона yury-universal-v1 у нас фикс. 10 slots.
  const targetSlots = 10;

  // ── Sonnet 4.6 — распределение
  const system = [
    'Ты — арт-директор Юрия Еремина (дизайнер интерьеров, основатель клуба «Реализация»).',
    'У тебя 10 готовых текстов слайдов карусели от копирайтера. Твоя задача — распределить их по slot-структуре премиум HTML-шаблона и вернуть JSON.',
    '',
    'Шаблон содержит 10 слайдов с фиксированными ролями:',
    '  slide_1  = COVER (заголовок-крючок + подзаголовок + автор)',
    '  slide_2..9 = BODY (хук + основной текст + опц. footnote)',
    '  slide_4 и slide_7 = QUOTE (только большая фраза-кавычка, без hook)',
    '  slide_10 = CTA (заголовок + субтекст + код-блок)',
    '',
    'Правила:',
    '- Текст слайда от копирайтера может содержать «—», обычно это самостоятельная мысль.',
    '- Headline и hook — короткие (2–8 слов). Если копирайтер написал длинно — извлеки суть.',
    '- В headline можно обернуть 1–2 слова в <em>...</em> — они выделятся курсивом-акцентом.',
    '- В body_html можно использовать <strong>...</strong> и <br> для разделения.',
    '- footnote — короткая подпись (опц., пустая строка если не нужно).',
    '- Не выдумывай новые факты. Все слова — из текстов слайдов или из контекста.',
    '- НЕ упоминай конкретные цены клуба, рубли, «5000».',
    '',
    'Верни СТРОГО JSON-объект ровно с этими ключами (без markdown-обёртки, без преамбулы):',
    '{',
    '  "deck_eyebrow": "1-3 слова, eyebrow над cover (типа: «Кейс ученицы», «Метод», «Разбор»)",',
    '  "slide_1_headline_html": "крупная фраза для cover, можно с <em>",',
    '  "slide_1_subhead": "1-2 предложения подзаголовка под cover",',
    '  "slide_2_hook": "хук-слово для slide 2",',
    '  "slide_2_body_html": "основной текст slide 2, с <strong> для акцентов",',
    '  "slide_2_footnote": "опц. короткая подпись или пустая строка",',
    '  "slide_3_hook": "...", "slide_3_body_html": "...", "slide_3_footnote": "",',
    '  "slide_4_body_html": "большая фраза-цитата для slide 4 (без hook, как pull-quote)",',
    '  "slide_4_footnote": "автор цитаты или пустая",',
    '  "slide_5_hook": "...", "slide_5_body_html": "...", "slide_5_footnote": "",',
    '  "slide_6_hook": "...", "slide_6_body_html": "...", "slide_6_footnote": "",',
    '  "slide_7_body_html": "цитата slide 7", "slide_7_footnote": "",',
    '  "slide_8_hook": "...", "slide_8_body_html": "...", "slide_8_footnote": "",',
    '  "slide_9_hook": "...", "slide_9_body_html": "...", "slide_9_footnote": "",',
    '  "slide_10_headline_html": "крупная CTA-фраза, с <em>",',
    '  "slide_10_subhead": "1-2 предложения зачем подписчику кликать"',
    '}',
  ].join('\n');

  // Передаём LLM пронумерованные тексты + контекст.
  const numbered = input.slidesText
    .slice(0, targetSlots)
    .map((t, i) => `(${i + 1}) ${t}`)
    .join('\n');

  const userMsg = [
    `КОНТЕКСТ ИДЕИ: ${input.ideaSummary}`,
    `БОЛЬ ЦА: ${input.painTag}`,
    `СТРАТЕГИЯ: ${input.strategy} (${STRATEGY_CTA[input.strategy]})`,
    `КОД ДЛЯ CTA: ${codeUpper}`,
    input.bonusTitle ? `БОНУС: ${input.bonusTitle}` : '',
    '',
    'ТЕКСТЫ СЛАЙДОВ ОТ КОПИРАЙТЕРА (распредели их по слотам):',
    numbered,
    '',
    'Верни JSON-объект.',
  ].filter(Boolean).join('\n');

  const startedAt = Date.now();
  const r = await callAnthropic({
    mode: 'generative',
    system,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: 4000,
    temperature: 0.4,
    traceTag: 'html-payload',
  });

  let parsed: Record<string, string>;
  try {
    parsed = parseJsonResponse<Record<string, string>>(r.text);
  } catch (err) {
    log.error({ rawHead: r.text.slice(0, 300) }, 'html-payload: JSON parse failed');
    throw new Error(`html-payload: invalid JSON from Sonnet — ${(err as Error).message.slice(0, 120)}`);
  }

  // Финальные deck_* slot'ы (генерируем сами, не от LLM).
  const payload: HtmlSlideData = {
    deck_title: input.ideaSummary.slice(0, 80),
    deck_brand: 'клуб «Реализация»',
    deck_author: 'Юрий Еремин',
    deck_total: '10',
    code_word_upper: codeUpper,
    slide_10_cta_text:
      input.strategy === 'B'
        ? 'Пиши это слово в Direct — пришлю ссылку на канал клуба.'
        : 'Пиши это слово в Direct — пришлю материалы.',
    ...parsed,
  };

  log.info(
    {
      codeWord: input.codeWord,
      strategy: input.strategy,
      slotCount: Object.keys(parsed).length,
      promptTokens: r.usage.input_tokens,
      completionTokens: r.usage.output_tokens,
      costUsd: r.costUsd,
      durationMs: Date.now() - startedAt,
    },
    'html-payload: generated',
  );
  return payload;
}
