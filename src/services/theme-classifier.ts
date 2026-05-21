// theme-classifier — определяет тему карусели для выбора эталонного шаблона.
//
// Алгоритм:
//   1. Regex-маппинг по keywords в текстах слайдов + summary (deterministic, быстро, бесплатно).
//   2. Если ни один тег не сработал → Haiku 4.5 classification (~5 копеек, fast).
//   3. Если и Haiku вернул мусор → fallback на 'expert' (универсальный).
//
// Темы соответствуют именам папок в GDrive:
//   04-carousel-templates-ye/
//     carousel-01-errors, carousel-02-promt, carousel-03-money, carousel-04-AI,
//     carousel-05-phrase, carousel-06-expert, carousel-07-color-trends, carousel-08-brend
//   05-carousel-templates-rz/
//     carousel-01-designers, carousel-02-Anna, carousel-03-Nataliya,
//     carousel-04-Anna-Kacapova, carousel-05-Anush

import { callAnthropic } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

export type CarouselTheme =
  | 'money'
  | 'errors'
  | 'AI'
  | 'prompt'
  | 'phrase'
  | 'expert'
  | 'color'
  | 'brand'
  | 'designers'
  | 'fallback';

export type VoiceCode = 'YE' | 'RZ';

interface RegexRule {
  theme: CarouselTheme;
  patterns: RegExp[];
}

// Каждый паттерн ищется в lowercased тексте. Порядок важен — первый матч выигрывает.
// Все patterns на русском, потому что весь контент — на русском.
const YE_RULES: readonly RegexRule[] = [
  {
    theme: 'money',
    patterns: [
      /\b(чек|выручк|оборот|доход|зарплат|прибыл|деньг|финанс|рубл|плат(ит|ят|у)|за\s+проект|за\s+м[2²])\b/i,
      /\b(подорож|подним.{0,4}\s+цен|увеличить\s+чек|поднять\s+(чек|цен))/i,
    ],
  },
  {
    theme: 'errors',
    patterns: [
      /\b(ошибк|провал|неудач|косяк|заблуждени|не\s+получ|неправильн|облом|тупик)\b/i,
      /\b(5\s+(заблуждени|ошиб)|почему\s+(не\s+)?(работает|получается))/i,
    ],
  },
  {
    theme: 'AI',
    patterns: [
      /\b(AI|ai|искусствен|нейросет|chatgpt|gpt|claude|midjourney|нейрон|нейро|midjourny)/i,
    ],
  },
  {
    theme: 'prompt',
    patterns: [
      /\b(промпт|prompt|запрос\s+к\s+(нейро|chat|gpt|ai)|инструкция\s+для\s+(нейро|gpt))/i,
    ],
  },
  {
    theme: 'phrase',
    patterns: [
      /\b(формулировк|фраз|сказать\s+клиенту|что\s+ответить|скрипт|речев|произнес|словам)/i,
    ],
  },
  {
    theme: 'color',
    patterns: [
      /\b(цвет|палитр|тренд|оттенк|colour|color\s+(palette|trend)|пантон|pantone)/i,
    ],
  },
  {
    theme: 'brand',
    patterns: [
      /\b(бренд|brand|позиционирован|айдентик|нейминг|лого|узнавае)/i,
    ],
  },
  {
    theme: 'expert',
    patterns: [
      /\b(эксперт|экспертн|опыт|лет\s+в\s+дизайн|кейс|портфолио|разбор|метод|подход)\b/i,
    ],
  },
];

const RZ_NAME_TO_FOLDER: Record<string, string> = {
  // lower-case name → имя папки в GDrive (без полного префикса)
  'anna kacapova': 'carousel-04-Anna Kacapova',
  'анна кацапова': 'carousel-04-Anna Kacapova',
  'кацапова': 'carousel-04-Anna Kacapova',
  'anush': 'carousel-05-Anush',
  'ануш': 'carousel-05-Anush',
  'nataliya': 'carousel-03-Nataliya',
  'наталия': 'carousel-03-Nataliya',
  'наталья': 'carousel-03-Nataliya',
  'anna': 'carousel-02-Anna', // если просто "Анна" без фамилии
  'анна': 'carousel-02-Anna',
};

/** YE-тема + имя папки в GDrive (без префикса 04-carousel-templates-ye/). */
const YE_THEME_TO_FOLDER: Record<CarouselTheme, string> = {
  errors: 'carousel-01-errors',
  prompt: 'carousel-02-promt',
  money: 'carousel-03-money',
  AI: 'carousel-04-AI',
  phrase: 'carousel-05-phrase',
  expert: 'carousel-06-expert',
  color: 'carousel-07-color trends',
  brand: 'carousel-08-brend',
  // RZ-only / fallback'и не используют YE-папки, но для типа нужны:
  designers: 'carousel-06-expert',
  fallback: 'carousel-06-expert',
};

export interface ClassifyResult {
  theme: CarouselTheme;
  templateFolderName: string;
  classifiedBy: 'regex' | 'llm' | 'fallback';
  classifierRaw?: string;
}

/** Главная функция: классифицирует тему + возвращает имя папки эталона в GDrive. */
export async function classifyCarouselTheme(
  text: string,
  voice: VoiceCode,
): Promise<ClassifyResult> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');

  if (voice === 'RZ') {
    // Сначала ищем имя ученицы.
    for (const [needle, folder] of Object.entries(RZ_NAME_TO_FOLDER)) {
      if (normalized.includes(needle)) {
        return {
          theme: 'designers',
          templateFolderName: folder,
          classifiedBy: 'regex',
        };
      }
    }
    // Дефолт RZ → общая designers-карусель.
    return {
      theme: 'designers',
      templateFolderName: 'carousel-01-designers',
      classifiedBy: 'fallback',
    };
  }

  // YE: regex по приоритету (money/errors/AI/prompt/phrase/color/brand/expert).
  for (const rule of YE_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(text)) {
        return {
          theme: rule.theme,
          templateFolderName: YE_THEME_TO_FOLDER[rule.theme],
          classifiedBy: 'regex',
        };
      }
    }
  }

  // Regex не сработал → Haiku 4.5.
  try {
    const r = await callAnthropic({
      mode: 'fast',
      system:
        'Ты классификатор тем для каруселей дизайн-клуба. Верни ОДНО слово из списка: ' +
        'money, errors, AI, prompt, phrase, expert, color, brand. ' +
        'Без объяснений, без точек.',
      messages: [
        {
          role: 'user',
          content: `Текст карусели:\n\n${text.slice(0, 2000)}\n\nКатегория?`,
        },
      ],
      traceTag: 'theme-classifier',
      maxTokens: 20,
      temperature: 0,
    });
    const guess = r.text.trim().toLowerCase().replace(/[^a-z]/g, '');
    const validThemes: CarouselTheme[] = [
      'money',
      'errors',
      'AI',
      'prompt',
      'phrase',
      'expert',
      'color',
      'brand',
    ];
    const matched = validThemes.find((t) => t.toLowerCase() === guess) ?? null;
    if (matched) {
      log.info(
        { guess, matched, cost_usd: r.costUsd },
        'theme-classifier: Haiku resolved',
      );
      return {
        theme: matched,
        templateFolderName: YE_THEME_TO_FOLDER[matched],
        classifiedBy: 'llm',
        classifierRaw: r.text.slice(0, 80),
      };
    }
    log.warn(
      { rawGuess: r.text.slice(0, 80) },
      'theme-classifier: Haiku returned unknown theme, falling back to expert',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'theme-classifier: Haiku call failed, falling back to expert',
    );
  }

  return {
    theme: 'expert',
    templateFolderName: YE_THEME_TO_FOLDER.expert,
    classifiedBy: 'fallback',
  };
}
