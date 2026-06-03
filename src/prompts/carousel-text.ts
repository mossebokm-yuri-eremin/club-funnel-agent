// carousel-text — генератор текстов слайдов карусели.
//
// Входы:
//   - YE-пост (уже согласован — это голос Юрия по идее)
//   - voice-analysis (запреты, обороты, реальные истории)
//   - количество слайдов (по умолчанию 10)
//
// Выход: массив строк-фраз для слайдов, каждая 30–120 символов.
// Никаких выдуманных имён/цифр — берём только из YE-поста и voice-analysis.real_stories.

import { getVoiceAnalysis } from '../services/voice-analysis-loader.js';

export const CAROUSEL_TEXT_PROMPT_NAME = 'carousel_text';
export const CAROUSEL_TEXT_PROMPT_VERSION = 'v3';

export interface BuildCarouselTextInput {
  /** Идея, на которую делается карусель. */
  ideaText: string;
  /** Согласованный YE-пост (полный текст). Источник фактов и формулировок. */
  yePost: string;
  /** Целевое число слайдов (5..10). По умолчанию 7. */
  totalSlides?: number;
  /** Кодовое слово CTA для последнего слайда. */
  codeWord?: string | null;
}

export interface BuildCarouselTextOutput {
  systemPrompt: string;
  userPrompt: string;
}

export async function buildCarouselTextPrompt(
  input: BuildCarouselTextInput,
): Promise<BuildCarouselTextOutput> {
  const voice = await getVoiceAnalysis('YE');
  const total = Math.max(5, Math.min(10, input.totalSlides ?? 7));

  const characteristic = voice.characteristic_phrases
    .slice(0, 15)
    .map((p) => `«${p.phrase}»`)
    .join(', ');

  const forbidden = voice.forbidden_constructions
    .slice(0, 20)
    .map((f) => `«${f}»`)
    .join(', ');

  const profErrors = voice.glossary.never_uses
    .slice(0, 15)
    .map((w) => `«${w}»`)
    .join(', ');

  const ctaSlide = input.codeWord
    ? `\nПоследний слайд (CTA) — оффер без давления с кодовым словом ${input.codeWord}:\n  Пример: «Хочешь разобраться? Напиши ${input.codeWord} в Direct.»`
    : `\nПоследний слайд (CTA) — БЕЗ кодового слова. Закрой риторическим вопросом или афоризмом.`;

  const systemPrompt = `Ты пишешь ТЕКСТ для карусели Юрия Еремина в Instagram.
Голос Юрия — рваный ритм, парцелляция, конкретика без штампов.
КРИТИЧНО: факты (имена, города, цифры) берёшь ТОЛЬКО из согласованного YE-поста.
Не выдумывай новых имён, городов, цифр, которых нет в посте.

═══════════════════════════════════════════════════════════════
ПРАВИЛА КАРУСЕЛИ
═══════════════════════════════════════════════════════════════
  • ${total} слайдов всего
  • Slide 1 (cover) — хук, ОДНА фраза, 30–80 символов
  • Slide 2..${total - 1} (body) — развёртка идеи, по 1–2 фразы на слайд, 40–120 символов
  • Slide ${total} (CTA) — финал
  • Каждый слайд = самостоятельная мысль, которую можно прочесть отдельно
  • Парцелляция: точка вместо запятой. Короткие удары. «Не А. Не Б. Не В.»
  • Бинарные противопоставления: «было/стало», «они/мы»

═══════════════════════════════════════════════════════════════
ХАРАКТЕРНЫЕ ОБОРОТЫ (вставляй на 1–2 слайдах)
═══════════════════════════════════════════════════════════════
${characteristic}

═══════════════════════════════════════════════════════════════
ЗАПРЕЩЕНО
═══════════════════════════════════════════════════════════════
Профошибки: ${profErrors}
Канцелярит / маркетинг: ${forbidden}
Sacred rule #11: никаких упоминаний цены клуба («5000», «5К», «5 000 ₽», «взнос»),
никаких «вступай в клуб», «купи курс», «жду тебя». Никаких MOSSEBO.
${ctaSlide}

═══════════════════════════════════════════════════════════════
ВЫХОД — JSON-массив строк, БЕЗ markdown-обёртки
═══════════════════════════════════════════════════════════════
Пример формата:
["Слайд 1 текст", "Слайд 2 текст", "Слайд 3 текст", ...]

Никаких объяснений, никаких преамбул, никакого markdown.`;

  const userPrompt = `Идея от Юрия:
«${input.ideaText.trim()}»

Согласованный YE-пост (источник фактов):
«««
${input.yePost.trim()}
»»»

Сделай ${total} слайдов для карусели. Верни JSON-массив строк.`;

  return { systemPrompt, userPrompt };
}
