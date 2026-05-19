// Промпты для генерации картинок слайдов карусели через AI-провайдер
// (seedream-4 GPTunnel — primary; Nano Banana — fallback если когда-то заработает).
//
// Брендовая палитра клуба «Реализация»:
//   - #ff7518 — основной акцент (оранжевый, «энергия реализации»)
//   - #2C2826 — графит (фон / текст-выноска)
//   - #dfdbd8 — тёплый бежевый (поддерживающий фон, бумага)
//
// Никаких УТП / «преимуществ» — только смыслы и образы боли/мечты ЦА.
// Стиль: чистый минимализм + типографика, не stock-photography, не AI-плакаты.
//
// Seedream-4 плохо умеет кириллицу — текст слайда НЕ передаётся в prompt.
// Sharp наносит текст поверх готовой картинки (см. carousel-renderer).

export const BRAND_COLORS = {
  primary: '#ff7518',
  graphite: '#2C2826',
  paper: '#dfdbd8',
} as const;

export interface CarouselSlidePromptInput {
  /** Текст слайда (1-3 предложения). Уже одобрен content-gen + voice-validator. */
  slideText: string;
  /** Порядковый номер слайда (1-based) — для контекста стиля. */
  slideIndex: number;
  /** Всего слайдов в карусели. */
  totalSlides: number;
  /** Тег боли — для подбора метафоры (например 'time_burnout', 'low_check', 'team_chaos'). */
  painTag: string;
  /** Опциональная подсказка стиля (если Юрий через UI задал референс). */
  styleHint?: string;
}

/** Главный билдер промпта для одного слайда. */
export function buildCarouselSlidePrompt(input: CarouselSlidePromptInput): string {
  const isCover = input.slideIndex === 1;
  const isClosing = input.slideIndex === input.totalSlides;
  const role = isCover
    ? 'обложка карусели — крупный hook, цепляющий с первого взгляда'
    : isClosing
      ? 'финальный слайд — закрывает мысль, оставляет inner click'
      : `средний слайд ${input.slideIndex}/${input.totalSlides} — раскрывает мысль`;

  const lines: string[] = [
    'Создай изображение для Instagram-карусели (формат 4:5, итоговый размер 1080×1350).',
    `Это ${role}.`,
    '',
    'ТЕКСТ НА СЛАЙДЕ (разместить крупно, читаемо, центрированно):',
    `«${input.slideText.trim()}»`,
    '',
    'СТИЛЬ И ПАЛИТРА (строго соблюсти):',
    `- Основной акцент: ${BRAND_COLORS.primary} (оранжевый, «энергия реализации»).`,
    `- Графит: ${BRAND_COLORS.graphite} (фон / текст-выноска).`,
    `- Бежевый: ${BRAND_COLORS.paper} (поддерживающий фон, тёплая бумага).`,
    '- Только эти 3 цвета + чистый белый, без других оттенков.',
    '- Шрифт sans-serif (Inter / Geist / Manrope), вес 600-700.',
    '- Минимализм: 1-2 графических элемента максимум, никакой стоковой эстетики.',
    '- Не использовать AI-аватаров людей, не имитировать фото.',
  ];

  if (input.painTag) {
    lines.push('');
    lines.push(`БОЛЬ АУДИТОРИИ (визуальная метафора может опираться на это): ${input.painTag}.`);
  }
  if (input.styleHint) {
    lines.push('');
    lines.push(`ДОПОЛНИТЕЛЬНО (от Юрия): ${input.styleHint}`);
  }

  lines.push(
    '',
    'ЗАПРЕЩЕНО:',
    '- Логотипы Instagram/Telegram/чужих брендов.',
    '- Лица людей и руки (карусель работает на типографике и абстракции).',
    '- Орфографические ошибки в русском тексте (если перенос строки — соблюсти его правильно).',
    '- Слова «УТП», «преимущества», «скидка», «целевая аудитория» — даже если они есть в исходном тексте, выкинь.',
  );

  return lines.join('\n');
}

/** Промпт для cover-слайда лонгрида (опционально, AC-20 для бонуса). */
export function buildLongreadCoverPrompt(input: {
  title: string;
  painTag: string;
}): string {
  return [
    `Создай обложку лонгрида (4:5, 1080×1350) для премиум-клуба дизайнеров «Реализация».`,
    '',
    `ЗАГОЛОВОК (крупно, в две строки): «${input.title.trim()}»`,
    '',
    'ПАЛИТРА (строго соблюсти):',
    `- ${BRAND_COLORS.primary} (оранжевый акцент).`,
    `- ${BRAND_COLORS.graphite} (графит, основной текст).`,
    `- ${BRAND_COLORS.paper} (тёплый бежевый фон).`,
    'Только эти 3 цвета + чистый белый.',
    '',
    'СТИЛЬ:',
    '- Минимализм, типографика sans-serif вес 700.',
    '- 1 графический акцент (геометрическая фигура / линия) в палитре.',
    '- В нижней части — мелким шрифтом подпись @yury_eremin (16-20px).',
    '',
    `БОЛЬ АУДИТОРИИ (метафора может опираться): ${input.painTag}.`,
    '',
    'ЗАПРЕЩЕНО: лица, руки, стоковые иллюстрации, AI-аватары, чужие логотипы.',
  ].join('\n');
}

/**
 * Промпт для Seedream-4 (GPTunnel): английский, без текста слайда внутри.
 * Sharp потом наложит русский текст поверх — Seedream плохо умеет кириллицу.
 *
 * Возвращает ВИЗУАЛЬНУЮ КОНЦЕПЦИЮ — что должно быть на фото (минималистичное,
 * editorial, premium), без слов «УТП», без брендов, без лиц/рук.
 */
export interface SeedreamVisualConceptInput {
  /** Текст слайда — даём ТОЛЬКО для смысловой подсказки модели, в prompt не вставляем. */
  slideText: string;
  slideIndex: number;
  totalSlides: number;
  painTag: string;
}

export function buildSeedreamVisualPrompt(input: SeedreamVisualConceptInput): string {
  const isCover = input.slideIndex === 1;
  const isClosing = input.slideIndex === input.totalSlides;
  // Английский, чтобы Seedream хорошо понял style. Текст слайда наносится Sharp поверх.
  const role = isCover
    ? 'opening cover slide of an Instagram carousel — strong visual hook with negative space at top for headline overlay'
    : isClosing
      ? 'closing slide of an Instagram carousel — calming finale with negative space for CTA overlay'
      : 'middle slide of a carousel — supporting illustration with negative space for body-text overlay';
  // Метафоры по pain_tag — лёгкие подсказки, не директивные.
  const painHint = mapPainToVisualHint(input.painTag);
  return [
    'Premium minimalist editorial photography, 9:16 vertical, magazine-quality.',
    `Role: ${role}.`,
    `Visual metaphor hint: ${painHint}.`,
    'Composition: clean, lots of negative space (especially at top OR bottom — leave 40% empty for text overlay).',
    'Color palette: warm orange #ff7518 accent, graphite #2C2826, warm beige paper #dfdbd8, off-white.',
    'Light: soft warm directional light, no harsh shadows, golden-hour or soft window light.',
    'Texture: paper, linen, matte ceramic, weathered wood — tactile editorial feel.',
    'Style references: Kinfolk magazine, Cereal magazine, The New Yorker photo essays.',
    '',
    'STRICT RULES:',
    '- NO text, NO letters, NO typography, NO words in any language.',
    '- NO logos, NO watermarks, NO brand marks.',
    '- NO human faces, NO hands, NO people (silhouettes acceptable only as extreme background).',
    '- NO AI-generated avatars, NO clip-art, NO stock-photo cliché.',
    '- NO bright saturated colors outside the palette.',
    '- Photorealistic editorial, not illustration.',
  ].join('\n');
}

function mapPainToVisualHint(painTag: string): string {
  const t = painTag.toLowerCase();
  if (t.includes('pricing') || t.includes('price') || t.includes('cena'))
    return 'a single object on a clean surface — symbolizing worth without showing money';
  if (t.includes('burnout') || t.includes('time'))
    return 'an empty workspace at dawn — exhaustion without depicting tired faces';
  if (t.includes('content') || t.includes('reels'))
    return 'a camera or notebook left on a table — content silence';
  if (t.includes('brand') || t.includes('public'))
    return 'a closed door with warm light leaking — restraint before stepping out';
  if (t.includes('product'))
    return 'pristine architectural detail — quiet confidence of finished work';
  // Default — нейтральная editorial композиция.
  return 'an architectural detail or designed object on warm surface — quiet confidence';
}
