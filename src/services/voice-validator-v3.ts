// voice-validator-v3 — динамический валидатор на основе knowledge/voice-analysis-ye-v3.md.
//
// В отличие от старого voice-validator.ts (хардкодные списки), эта версия читает
// запреты, характерные обороты и реальные истории из JSON-анализа.
//
// Используется content-gen после генерации:
//   - YE-пост → validate('YE', text)
//   - RZ-пост → validate('RZ', text)
//   - Carousel-text → validateFacts(text, sourcePost) — факты согласованы с YE-постом
//
// Retry-логика (3 попытки) живёт в content-gen-v3.ts, не здесь.

import { getVoiceAnalysis, type VoiceAnalysis } from './voice-analysis-loader.js';

export type ContentKindV3 = 'reel' | 'tg_post' | 'carousel' | 'ig_caption' | 'rz_post' | 'generic';

export interface VoiceValidatorReport {
  ok: boolean;
  violations: Array<{
    kind:
      | 'forbidden'
      | 'profession'
      | 'price'
      | 'curator'
      | 'invented_fact'
      | 'length'
      | 'missing_element'
      | 'hallucinated_capital'
      | 'jarring_metaphor'
      | 'repeated_ending'
      | 'weather_hook_overuse';
    marker: string;
    correction?: string;
  }>;
  characteristic_hits: number;
  missing_characteristics: string[];
  word_count: number;
  short_sentences: number;
  digits_count: number;
  names_found: string[];
  cities_found: string[];
  you_addressing: boolean;
  reason?: string;
}

/**
 * Контекст из истории content_packages — для проверки 6b (повторяющиеся концовки)
 * и 6c (погодные хуки). Заполняется content-gen перед вызовом.
 */
export interface HistoryContext {
  /** Concatenated text последних YE-tg_post + reel за 7 дней (для grep'а endings). */
  last7DaysText?: string;
  /** Concatenated text последних 3 reels (для grep'а weather hooks). */
  last3ReelsText?: string;
}

const BOL = '(?<![а-яёА-ЯЁ])';
const EOL = '(?![а-яёА-ЯЁ])';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function countWords(text: string): number {
  return (text.trim().match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

const PRICE_PATTERNS: Array<{ marker: string; regex: RegExp }> = [
  { marker: '5000 ₽/руб', regex: /\b5\s*000\s*[₽р]/iu },
  { marker: '5000 руб', regex: /\b5\s*000\s*(?:руб|р\.)/iu },
  { marker: '5к в контексте цены', regex: /\b5\s*[кk]\b(?=[^.]{0,40}(?:мес|месяц|клуб|реализ|взнос|оплат))/iu },
  { marker: 'пять тысяч', regex: /\bпять\s+тысяч\b/iu },
];

// RZ-specific: куратор-голос запрещён.
const RZ_CURATOR_PATTERNS: Array<{ marker: string; regex: RegExp }> = [
  { marker: 'я разбирала с …', regex: new RegExp(`${BOL}(?:я|мы)\\s+разбира(?:ла|л|ли|ем)[а-яё]*\\s+(?:с|у)\\s+[А-ЯЁ][а-яё]+`, 'iu') },
  { marker: 'мы с участницами клуба', regex: new RegExp(`${BOL}мы\\s+с\\s+(?:участниц|девочк|резидентк)[а-яё]+\\s+(?:клуб|реализ)`, 'iu') },
  { marker: 'многие дизайнеры верят/думают', regex: new RegExp(`${BOL}мног(?:ие|их|ими)\\s+дизайнер[а-яё]+\\s+(?:верят|думают|считают|искренне)`, 'iu') },
  { marker: 'и вот что я хочу сказать каждой', regex: new RegExp(`${BOL}(?:и\\s+)?вот\\s+что\\s+я\\s+(?:хочу|хотела)\\s+сказать`, 'iu') },
  { marker: 'я наставница/куратор/веду клуб', regex: new RegExp(`${BOL}я\\s+(?:наставниц|куратор|веду\\s+клуб)`, 'iu') },
  { marker: 'знаешь что я заметила', regex: new RegExp(`${BOL}знаешь\\s+что\\s+я\\s+заметила`, 'iu') },
  { marker: 'оказалась/оказалось (в смысле «поняла»)', regex: new RegExp(`${BOL}оказа(?:ло|ла)с(?:ь|я)${EOL}`, 'iu') },
];

// Проф-ошибки общие для YE и RZ (склонения учтены).
const PROF_PATTERNS: Array<{ marker: string; regex: RegExp; correction: string }> = [
  { marker: 'дорогой чек', regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+чек[а-яё]*${EOL}`, 'iu'), correction: 'высокий чек / целевой чек' },
  { marker: 'дешёвый чек', regex: new RegExp(`${BOL}деш[её]в(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+чек[а-яё]*${EOL}`, 'iu'), correction: 'низкий чек' },
  { marker: 'дорогой клиент', regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+клиент[а-яё]*${EOL}`, 'iu'), correction: 'платёжеспособный клиент' },
  { marker: 'дешёвый клиент', regex: new RegExp(`${BOL}деш[её]в(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+клиент[а-яё]*${EOL}`, 'iu'), correction: 'клиент эконом-сегмента' },
  { marker: 'дорогой проект', regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+проект[а-яё]*${EOL}`, 'iu'), correction: 'большой / премиум-проект' },
  { marker: 'оказывать услуги', regex: new RegExp(`${BOL}оказыва[а-яё]+\\s+услуг[а-яё]*${EOL}`, 'iu'), correction: 'делать дизайн / вести проект' },
  { marker: 'предоставлять услуги', regex: new RegExp(`${BOL}предоставл[а-яё]+\\s+услуг[а-яё]*${EOL}`, 'iu'), correction: 'делать дизайн / работать' },
  { marker: 'осуществлять', regex: new RegExp(`${BOL}осуществл[а-яё]+${EOL}`, 'iu'), correction: 'делать / запускать' },
  { marker: 'шоурум', regex: new RegExp(`${BOL}шоурум[а-яё]*${EOL}`, 'iu'), correction: 'переговорка / офис / студия' },
  { marker: 'целевая аудитория', regex: new RegExp(`${BOL}целев(?:ая|ой|ую|ые|ыми|ых)\\s+аудитори[а-яё]*${EOL}`, 'iu'), correction: 'аудитория / клиенты' },
  { marker: 'ЦА (сокращение)', regex: /(?<![А-ЯЁа-яё\w])ЦА(?![А-ЯЁа-яё\w])/u, correction: 'аудитория' },
  { marker: 'дизайн-интерьер (через дефис)', regex: new RegExp(`${BOL}дизайн-интерьер[а-яё]*${EOL}`, 'iu'), correction: 'дизайн интерьера' },
];

function findFirst(text: string, re: RegExp): boolean {
  return re.test(text);
}

export interface ValidateOptions {
  /** Минимум характерных оборотов на пост ≥150 слов. По умолчанию 2. */
  minCharacteristics?: number;
  /** Применять курaтор-валидацию (только для RZ). */
  voice: 'YE' | 'RZ' | 'carousel';
  /** Тип артефакта — определяет проверки длины и обязательных элементов. */
  kind?: ContentKindV3;
  /** Кэшированный voice-analysis. Если не передан — будет загружен из файла. */
  voiceAnalysis?: VoiceAnalysis;
  /** История недавнего контента (для запретов повторов и weather-hook overuse). */
  history?: HistoryContext;
}

// Слова которые ВНУТРИ предложения могут стоять с заглавной только если это:
// - имя из real_stories
// - географическое имя (город из real_stories)
// - служебное слово в начале предложения (после .!?)
// - аббревиатура (например, MOSSEBO, ЦА — уже отбраковываются отдельно)
// Всё остальное — потенциальная галлюцинация типа "Матрас" в середине поста.
const COMMON_RU_TITLES = new Set([
  'Реализация', 'Москва', 'Россия', 'Сбер', 'Telegram', 'Instagram',
  'Midjourney', 'Stable', 'Diffusion', 'ArchiCAD', 'Revit', 'Direct',
  'Юрий', 'Юрия', 'Юрию', 'Юрием',
  // Имена и фамилии real_stories (ТЗ Юрия 2026-06-08):
  'Анна', 'Анны', 'Анну', 'Анне', 'Анной',
  'Кацапова', 'Кацаповой', 'Кацапову',
  'Наталья', 'Натальи', 'Наталье', 'Натальей',
  'Собур',
  'Ануш', 'Ануши', 'Ануше',
  'Чернышова', 'Чернышовой',
  'Ольга', 'Ольги', 'Ольге', 'Ольгой',
  'Анастасия', 'Анастасии', 'Анастасией',
  'Татьяна', 'Татьяны', 'Татьяне', 'Татьяной',
  'Диденко',
  'Мария', 'Марии', 'Марией',
  'Виктория', 'Виктории', 'Викторией',
  // Города из real_stories:
  'Нижневартовск', 'Нижневартовске', 'Нижневартовску', 'Нижневартовска',
  'Екатеринбург', 'Екатеринбурга', 'Екатеринбурге',
  'Алдан', 'Алдана', 'Алдане',
  'Самара', 'Самары', 'Самаре',
  'Хабаровск', 'Хабаровска', 'Хабаровске',
  // Контекст-слова (часто Capitalized в начале фразы):
  'Эксперт', 'Эксперта', 'Эксперту', 'Экспертом',
  'Клуб', 'Клуба', 'Клубе', 'Клубом',
]);

// "Внезапные" метафоры — образы из жизни, далёкие от строительной индустрии,
// которые не имеют контекста в этом посте и звучат как галлюцинация.
// "Матрас" в посте про авторский надзор — пример.
const JARRING_NOUNS = ['матрас', 'тротуар', 'паркинг', 'диван', 'газон', 'фонарь', 'тележка'];

// Погодные хуки (6c) — допустимы редко, не в каждом рилсе подряд.
const WEATHER_HOOK_PATTERNS: Array<{ marker: string; regex: RegExp }> = [
  { marker: 'минус N за окном', regex: /минус\s+\d{1,2}\s+за\s+окн/iu },
  { marker: 'дождь', regex: /(?<![а-яёА-ЯЁ])(дождь|дождик|идёт\s+дождь|пош(?:ёл|ел)\s+дождь)/iu },
  { marker: 'снег', regex: /(?<![а-яёА-ЯЁ])(снег|снегопад|метель|вьюга)(?![а-яёА-ЯЁ])/iu },
  { marker: 'зима/мороз', regex: /минус\s+\d+\s+градус|мороз|снежн/iu },
];

// 6b: типичные шаблонные концовки которые повторять не нужно.
const REPEATABLE_ENDINGS = [
  'это и есть механика',
  'это работает',
  'логика простая',
  'это и есть',
];

function countShortSentences(text: string): number {
  // Предложения, разделённые .!? — считаем те где 1-4 слова (короткие удары)
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return sentences.filter((s) => {
    const w = (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
    return w >= 1 && w <= 4;
  }).length;
}

function countDigits(text: string): number {
  return (text.match(/\d/g) ?? []).length;
}

function hasYouAddressing(text: string): boolean {
  // Юрий часто переходит на «ты»: «А ты», «у тебя», «ты сам», «ты понимаешь»
  return /(?<![А-ЯЁа-яё\w])(?:ты|тебя|тебе|тобой|тебе|твой|твоя|твоё|твои)(?![А-ЯЁа-яё\w])/iu.test(text);
}

function findNamesFromWhitelist(text: string, whitelist: string[]): string[] {
  const found = new Set<string>();
  for (const name of whitelist) {
    if (!name) continue;
    const re = new RegExp(`(?<![А-ЯЁа-яё\\w])${escapeRegex(name)}(?![А-ЯЁа-яё\\w])`, 'iu');
    if (re.test(text)) found.add(name);
  }
  return Array.from(found);
}

export async function validateVoiceV3(
  text: string,
  opts: ValidateOptions,
): Promise<VoiceValidatorReport> {
  const voice = opts.voiceAnalysis ?? (await getVoiceAnalysis(opts.voice === 'RZ' ? 'RZ' : 'YE'));
  const violations: VoiceValidatorReport['violations'] = [];
  const wordCount = countWords(text);

  // 1) Forbidden constructions (динамически из voice-analysis JSON)
  for (const phrase of voice.forbidden_constructions) {
    const re = new RegExp(escapeRegex(normalize(phrase)), 'iu');
    if (re.test(normalize(text))) {
      violations.push({ kind: 'forbidden', marker: phrase });
    }
  }

  // 2) Проф-ошибки (склонения)
  for (const { marker, regex, correction } of PROF_PATTERNS) {
    if (findFirst(text, regex)) {
      violations.push({ kind: 'profession', marker, correction });
    }
  }

  // 3) Цена клуба (sacred rule #11)
  for (const { marker, regex } of PRICE_PATTERNS) {
    if (findFirst(text, regex)) {
      violations.push({ kind: 'price', marker });
    }
  }

  // 4) Курaтор-конструкции для RZ
  if (opts.voice === 'RZ') {
    for (const { marker, regex } of RZ_CURATOR_PATTERNS) {
      if (findFirst(text, regex)) {
        violations.push({ kind: 'curator', marker });
      }
    }
  }

  // 4a) Mid-sentence Capitalized слова — потенциальные галлюцинации.
  // "Матрас", "Тротуар" с большой буквы в середине предложения = модель выдумала.
  // Whitelist: имена из real_stories + cities + COMMON_RU_TITLES.
  const allNames = new Set<string>([
    ...COMMON_RU_TITLES,
    ...voice.real_stories.map((s) => s.name).filter((x): x is string => Boolean(x)),
    ...voice.real_stories
      .map((s) => s.city)
      .filter((x): x is string => Boolean(x)),
  ]);
  // Найти Capitalized слова которые ИДУТ ПОСЛЕ непунктуационного символа в той же строке.
  // Простой подход: split по предложениям → проверять с 2-го слова.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const words = s.trim().split(/\s+/);
    // первое слово — естественно с заглавной; со второго проверяем
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!.replace(/[.,!?;:«»"'()\-—]/g, '');
      if (w.length >= 4 && /^[А-ЯЁ][а-яё]+$/u.test(w) && !allNames.has(w)) {
        // Пропустить причастные / относительные формы (Который, Та, Тот и т.д.)
        if (/^(?:Который|Которая|Которое|Которые|Которых|Которым|Которой|Какой|Какая|Какое|Какие)$/iu.test(w)) continue;
        violations.push({
          kind: 'hallucinated_capital',
          marker: `«${w}» с заглавной в середине предложения — не из real_stories, выглядит как галлюцинация`,
        });
        break; // одного нарушения на предложение хватит
      }
    }
  }

  // 4b) Внезапные метафоры — "Матрас. Вы продаёте матрас?" в контексте дизайна без объяснения.
  for (const noun of JARRING_NOUNS) {
    const re = new RegExp(`(?<![а-яёА-ЯЁ])${noun}(?![а-яёА-ЯЁ])`, 'iu');
    if (re.test(text)) {
      // Допускаем если есть пояснение (контекст продажи / сравнения уже введён в предыдущем абзаце).
      // Простая эвристика: если слово встречается только один раз и без сравнительной частицы — флаг.
      const matches = text.toLowerCase().match(new RegExp(`${noun}`, 'g')) ?? [];
      if (matches.length === 1) {
        violations.push({
          kind: 'jarring_metaphor',
          marker: `внезапная метафора «${noun}» без развёртывания — используй образы из стройки/дизайна/ремонта`,
        });
      }
    }
  }

  // 4c) Повтор шаблонной концовки за последние 7 дней (history).
  if (opts.history?.last7DaysText) {
    const hist = normalize(opts.history.last7DaysText);
    for (const ending of REPEATABLE_ENDINGS) {
      const n = normalize(ending);
      const inText = normalize(text).includes(n);
      const inHistory = hist.includes(n);
      if (inText && inHistory) {
        violations.push({
          kind: 'repeated_ending',
          marker: `концовка «${ending}» уже была в последних 7 днях — используй другую формулировку`,
        });
      }
    }
  }

  // 4d) Погодный хук в последних 3 рилсах (history).
  if ((opts.kind === 'reel') && opts.history?.last3ReelsText) {
    const hist = opts.history.last3ReelsText;
    for (const { marker, regex } of WEATHER_HOOK_PATTERNS) {
      if (regex.test(text) && regex.test(hist)) {
        violations.push({
          kind: 'weather_hook_overuse',
          marker: `погодный хук «${marker}» уже использован в последних 3 рилсах — придумай другой заход`,
        });
      }
    }
  }

  // 5) Характерные обороты
  const kind = opts.kind ?? 'generic';
  const requireMinChar = (kind === 'reel') ? 4 : (kind === 'tg_post' || kind === 'ig_caption') ? 3 : (opts.minCharacteristics ?? 2);
  let charHits = 0;
  const missing: string[] = [];
  for (const cp of voice.characteristic_phrases.slice(0, 20)) {
    const re = new RegExp(escapeRegex(normalize(cp.phrase)), 'iu');
    if (re.test(normalize(text))) {
      charHits++;
    } else {
      missing.push(cp.phrase);
    }
  }

  // 6) Длина и обязательные элементы (только для reel / tg_post)
  const shortSentences = countShortSentences(text);
  const digitsCount = countDigits(text);
  const yourAddressing = hasYouAddressing(text);
  const realNamesWhitelist = voice.real_stories
    .map((s) => s.name)
    .filter((n): n is string => Boolean(n));
  const cityWhitelist = voice.real_stories
    .map((s) => s.city)
    .filter((c): c is string => Boolean(c));
  const namesFound = findNamesFromWhitelist(text, realNamesWhitelist);
  const citiesFound = findNamesFromWhitelist(text, cityWhitelist);

  if (kind === 'reel') {
    if (wordCount < 220) {
      violations.push({ kind: 'length', marker: `reel слишком короткий (${wordCount} слов, нужно 220-450)` });
    }
    if (wordCount > 450) {
      violations.push({ kind: 'length', marker: `reel слишком длинный (${wordCount} слов, нужно 220-450)` });
    }
    if (shortSentences < 5) {
      violations.push({ kind: 'missing_element', marker: `мало коротких предложений 1-4 слова (${shortSentences}, нужно ≥5)` });
    }
    if (digitsCount < 2) {
      violations.push({ kind: 'missing_element', marker: `мало цифр в тексте (${digitsCount}, нужно ≥2 конкретных цифры)` });
    }
    if (!yourAddressing) {
      violations.push({ kind: 'missing_element', marker: 'нет перехода на «ты» (А ты / у тебя / ты сам)' });
    }
  } else if (kind === 'tg_post') {
    if (wordCount < 280) {
      violations.push({ kind: 'length', marker: `tg_post слишком короткий (${wordCount} слов, нужно 280-700)` });
    }
    if (wordCount > 700) {
      violations.push({ kind: 'length', marker: `tg_post слишком длинный (${wordCount} слов, нужно 280-700)` });
    }
    if (shortSentences < 6) {
      violations.push({ kind: 'missing_element', marker: `мало коротких предложений (${shortSentences}, нужно ≥6)` });
    }
    if (digitsCount < 3) {
      violations.push({ kind: 'missing_element', marker: `мало цифр (${digitsCount}, нужно ≥3)` });
    }
    if (!yourAddressing) {
      violations.push({ kind: 'missing_element', marker: 'нет перехода на «ты»' });
    }
  } else if (kind === 'ig_caption') {
    if (wordCount < 200) {
      violations.push({ kind: 'length', marker: `ig_caption слишком короткий (${wordCount} слов, нужно 200-500)` });
    }
    if (wordCount > 500) {
      violations.push({ kind: 'length', marker: `ig_caption слишком длинный (${wordCount} слов, нужно 200-500)` });
    }
    if (digitsCount < 2) {
      violations.push({ kind: 'missing_element', marker: `мало цифр (${digitsCount}, нужно ≥2)` });
    }
    if (!yourAddressing) {
      violations.push({ kind: 'missing_element', marker: 'нет перехода на «ты»' });
    }
    // Запрет эмодзи в основном тексте: ищем эмодзи ВНЕ строки хештегов.
    // Эвристика: хештеги обычно в финале (последний абзац начинается с #).
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const lastIsHashtags = lines.length > 0 && lines[lines.length - 1]!.startsWith('#');
    const mainText = lastIsHashtags ? lines.slice(0, -1).join('\n') : text;
    // Юникод-эмодзи (грубо: символы вне ASCII + базовой кириллицы + типографики).
    const emojiRegex = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}]/u;
    if (emojiRegex.test(mainText)) {
      const matched = mainText.match(emojiRegex);
      violations.push({
        kind: 'forbidden',
        marker: `эмодзи в основном тексте caption запрещены (только в строке хештегов): "${matched?.[0] ?? '?'}"`,
      });
    }
  }

  const ok =
    violations.length === 0 &&
    (wordCount < 100 || charHits >= requireMinChar);

  const report: VoiceValidatorReport = {
    ok,
    violations,
    characteristic_hits: charHits,
    missing_characteristics: missing.slice(0, 8),
    word_count: wordCount,
    short_sentences: shortSentences,
    digits_count: digitsCount,
    names_found: namesFound,
    cities_found: citiesFound,
    you_addressing: yourAddressing,
  };
  if (!ok) {
    if (violations.length > 0) {
      report.reason = `${violations.length} violations: ${violations.slice(0, 3).map((v) => v.marker).join(' | ')}`;
    } else if (charHits < requireMinChar) {
      report.reason = `only ${charHits}/${requireMinChar} characteristic phrases used (need from: ${voice.characteristic_phrases.slice(0, 5).map((p) => p.phrase).join(' / ')})`;
    }
  }
  return report;
}

/** Извлекает имена и числа из текста и сверяет с whitelist (yePost + voice_analysis.real_stories). */
export async function validateFacts(
  carouselText: string,
  yePost: string,
): Promise<{ ok: boolean; inventedNames: string[]; inventedNumbers: string[] }> {
  const voice = await getVoiceAnalysis('YE');
  const whitelist = new Set<string>();
  for (const s of voice.real_stories) {
    if (s.name) whitelist.add(normalize(s.name));
    if (s.city) whitelist.add(normalize(s.city));
  }
  // Дополнительно — всё что есть в yePost
  for (const w of normalize(yePost).match(/[а-яё]+/gu) ?? []) {
    whitelist.add(w);
  }

  // Извлекаем потенциальные имена. Эвристика:
  //   - Capitalized + ≥4 буквы
  //   - НЕ окончание прилагательного/причастия/местоимения
  //   - НЕ в COMMON_STARTS (см. ниже)
  // Имя должно быть либо в whitelist (real_stories + yePost), либо отвергается.
  const nameCandidates = carouselText.match(/[А-ЯЁ][а-яё]{3,}/gu) ?? [];
  const inventedNames: string[] = [];
  for (const n of nameCandidates) {
    // Эвристика: окончания местоимений / причастий / прилагательных — не имена
    if (/(?:ого|его|ому|ему|ыми|ими|ыми|ыми|ыми|ыми)$/iu.test(n)) continue;
    if (/(?:ый|ой|ая|ое|ые|их|ыми|ых|ыми|ому|ему|ого|его)$/iu.test(n)) continue;
    if (/(?:торый|торая|торое|торые|торых|торыми|торому|торой)$/iu.test(n)) continue;
    if (!whitelist.has(normalize(n))) {
      // Не блокируем общие слова в начале предложения; ищем только похожие на имя/город
      // — оставляем только если это не служебная лексика
      const COMMON_STARTS = new Set([
        // Служебная лексика и местоимения
        'Это', 'Так', 'Но', 'И', 'А', 'Если', 'Когда', 'Что', 'Кто', 'Где',
        'Почему', 'Зачем', 'Как', 'Чтобы', 'Вот', 'Подождите', 'Можно', 'Нельзя',
        'Только', 'Без', 'После', 'До', 'Перед', 'Над', 'Под', 'За',
        'Все', 'Всё', 'Каждый', 'Каждая', 'Каждое', 'Любой', 'Любая', 'Несколько',
        'Они', 'Она', 'Он', 'Оно', 'Я', 'Ты', 'Мы', 'Вы',
        'Не', 'Да', 'Нет', 'Может', 'Можешь', 'Должен', 'Должна', 'Должно', 'Нужно', 'Надо',
        'Хочешь', 'Хотите', 'Хочется', 'Знаешь', 'Знаете',
        'Помнишь', 'Помните', 'Представь', 'Представьте',
        // Глаголы 1/2/3 лица
        'Сделал', 'Сделала', 'Сделали', 'Делает', 'Делаешь',
        'Работает', 'Работаешь', 'Работаю',
        'Закончил', 'Закончила', 'Начал', 'Начала',
        'Получил', 'Получила', 'Заплатил', 'Заплатила',
        'Объясняю', 'Расскажу', 'Покажу',
        // Существительные про работу/деньги
        'Человек', 'Люди', 'Дизайн', 'Дизайнер', 'Дизайнеры', 'Архитектор', 'Архитекторы',
        'Клиент', 'Клиенты', 'Заказчик', 'Заказчики',
        'Студия', 'Студии', 'Офис', 'Команда', 'Бренд', 'Личный',
        'Проект', 'Проекты', 'Объект', 'Объекты',
        'Чертёж', 'Чертежи', 'Чек', 'Цена', 'Стоимость', 'Деньги',
        'Главное', 'Важное', 'Лучшее', 'Худшее',
        // Время
        'Сейчас', 'Тогда', 'Вчера', 'Сегодня', 'Завтра', 'Сначала', 'Потом',
        // Города/гео часто упоминаемые
        'Москва', 'Россия', 'Реализация', 'Думаешь', 'Думаете',
      ]);
      if (!COMMON_STARTS.has(n)) {
        inventedNames.push(n);
      }
    }
  }

  // Извлекаем числа > 999 (не дата) — проверяем что они встречаются в yePost
  const numCandidates = carouselText.match(/\b\d{4,}\b/g) ?? [];
  const inventedNumbers: string[] = [];
  const yeNorm = yePost;
  for (const num of numCandidates) {
    if (!yeNorm.includes(num)) {
      inventedNumbers.push(num);
    }
  }

  return {
    ok: inventedNames.length === 0 && inventedNumbers.length === 0,
    inventedNames,
    inventedNumbers,
  };
}
