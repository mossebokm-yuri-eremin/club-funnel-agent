// СВЯТОЙ файл — см. CLAUDE.md §2 «Голос Юрия — sacred».
// Любое изменение списков маркеров требует синхронизации с migration 002_seed_voices
// и записи в prompt_versions при бампе версии TWIN_YE/TWIN_RZ.

export type VoiceCode = 'YE' | 'RZ';

export interface ForbiddenHit {
  marker: string;
  positions: number[]; // байтовые позиции в lowercased-тексте — для подсветки
}

export interface RequiredHit {
  marker: string;
  count: number;
}

export interface VoiceValidatorReport {
  voice_code: VoiceCode;
  ok: boolean;
  violations: ForbiddenHit[];
  missingMarkers: string[];
  required_markers_found: RequiredHit[];
  density_per_100w: number;
  score: number; // alias density_per_100w — публичное поле API
  word_count: number;
  reason?: string;
  suggestion?: string;
}

export interface VoiceMarkers {
  required: readonly string[];
  forbidden: readonly string[];
}

// Дефолтные маркеры синхронизированы с migrations/002_seed_voices.sql.
// При расхождении — мигрируем БД и обновляем здесь одной правкой.
export const YE_MARKERS: VoiceMarkers = {
  // v2 — реальные обороты из 18 постов Юрия (см. knowledge/voice-analysis-ye.md).
  // Минимум 1 обязательный маркер на пост ≥150 слов.
  required: [
    'так вот',
    'и всё',
    'вот тогда',
    'подождите',
    'это уже происходит',
    'горжусь',
    'точка',
    'и так может',
    'это не',  // паттерн противопоставления «это не X — это Y»
    'не [a-zа-я]+ — а',  // «Не продавать — а проповедовать» (regex-style marker tolerated as substring)
  ],
  forbidden: [
    // Канцелярит
    'дело в том',
    'таким образом',
    'следует отметить',
    'необходимо подчеркнуть',
    'возможно',
    'пожалуй',
    'наверное',
    'является',
    'осуществляется',
    'проводится',
    // Маркетинговые штампы
    'УТП',
    'возражения',
    'синергия',
    'целевая аудитория',
    'эксклюзивное предложение',
    'не упустите шанс',
    'успех гарантирован',
    'хочу поделиться',
    'дорогие подписчики',
    'друзья мои',
    'уважаемые',
    'подписывайтесь',
    'специальное предложение',
    'успей',
    'лимитированно',
    // Прямая продажа клуба (sacred rule #11)
    'вступай в клуб',
    'жду тебя в реализации',
    'приходи в клуб',
    'купи курс',
    'купить курс',
    'стоит N рублей',
    'взнос',
    'членство',
    '5000',
    '5К',
    'пять тысяч',
    '5 000 ₽',
    // Старая сеть Юрия — запрещено
    'mossebo',
    'MOSSEBO',
  ],
};

// v3 (2026-06-03): Виктория = УЧАСТНИЦА клуба, не куратор.
// Required markers — от первого лица о СЕБЕ.
export const RZ_MARKERS: VoiceMarkers = {
  required: [
    'я долго думала',
    'я была там же',
    'я держалась',
    'до клуба',
    'после того как пришла в клуб',
    'юрий сказал',
    'юрий тогда сказал',
    'я попробовала',
    'сейчас я понимаю',
    'признаюсь честно',
    'у меня была',
    'я не суперэксперт',
    'я',  // личное лицо участницы
  ],
  forbidden: [
    // Канцелярит
    'дело в том',
    'таким образом',
    'следует отметить',
    'возможно',
    'является',
    'осуществляется',
    // Сюсюканье
    'дорогие подписчики',
    'дорогие девочки',
    'мои хорошие',
    'зайки',
    'солнышки',
    // Маркетинг
    'УТП',
    'возражения',
    'синергия',
    'эксклюзивное предложение',
    'не упустите шанс',
    'успех гарантирован',
    // Прямая продажа клуба
    'вступай в клуб',
    'жду тебя',
    'купи курс',
    'купить курс',
    'взнос',
    'членство',
    '5000',
    '5К',
    'пять тысяч',
    'mossebo',
    'MOSSEBO',
  ],
};

export const DEFAULT_MIN_DENSITY = 0.3; // markers per 100 words, см. SPEC AC-14

// Sacred rule #11: цена клуба запрещена в контенте для холодной аудитории
// (раскрывается только в письмах 7–8 прогрева и на лендинге GetCourse).
// Паттерны ловят явное упоминание суммы / взноса, но НЕ статистику
// («5000+ дизайнеров», «15 000 интерьеров» — нет валюты / «/мес», проходит).
export const PRICE_PATTERNS: ReadonlyArray<{ marker: string; regex: RegExp }> = [
  { marker: '5000 ₽/руб', regex: /\b5\s*000\s*[₽р]/iu },
  { marker: '5000 руб', regex: /\b5\s*000\s*(?:руб|р\.)/iu },
  { marker: '5к/мес', regex: /\b5\s*[кk]\s*[₽/]/iu },
  { marker: '5к (в контексте цены)', regex: /\b5\s*[кk]\b(?=[^.]{0,40}(?:мес|месяц|клуб|реализ|взнос|оплат))/iu },
  { marker: 'пять тысяч', regex: /\bпять\s+тысяч\b/iu },
  { marker: 'N 000 ₽/мес', regex: /\b\d{1,2}\s*000\s*₽?\s*\/\s*мес/iu },
  { marker: 'N 000 в мес', regex: /\b\d{1,2}\s*000\s*₽?\s*в\s*мес/iu },
];

// Профессиональные ошибки в речи дизайнера-наставника (см. SKILL yury-voice-master).
// «Дорогой чек» / «дешёвый клиент» / «оказывать услуги» = непрофессионал,
// убивает доверие у целевой аудитории дизайнеров. Применяется к YE и RZ.
//
// ВАЖНО: \b в JS не работает с кириллицей (word boundary = ASCII).
// Используем lookbehind/lookahead с явным набором кириллических букв:
//   (?<![а-яёА-ЯЁ]) — слева НЕ кириллица (или начало строки)
//   (?![а-яёА-ЯЁ])  — справа НЕ кириллица (или конец строки)
const BOL = '(?<![а-яёА-ЯЁ])'; // before-letter (left boundary)
const EOL = '(?![а-яёА-ЯЁ])';  // end-letter (right boundary)

export const PROFESSIONAL_ERROR_PATTERNS: ReadonlyArray<{ marker: string; regex: RegExp; correction: string }> = [
  {
    marker: 'дорогой чек',
    regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+чек(?:а|у|ом|е|и|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'высокий чек / целевой чек',
  },
  {
    marker: 'дешёвый чек',
    regex: new RegExp(`${BOL}деш[её]в(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+чек(?:а|у|ом|е|и|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'низкий чек / маленький чек',
  },
  {
    marker: 'дорогой клиент',
    regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+клиент(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'платёжеспособный клиент / премиум-клиент',
  },
  {
    marker: 'дешёвый клиент',
    regex: new RegExp(`${BOL}деш[её]в(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+клиент(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'клиент эконом-сегмента',
  },
  {
    marker: 'дорогой проект',
    regex: new RegExp(`${BOL}дорог(?:ой|ого|ому|им|ом|ие|их|ими)\\s+проект(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'большой проект / премиум-проект',
  },
  {
    marker: 'богатый клиент',
    regex: new RegExp(`${BOL}богат(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+клиент(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'платёжеспособный клиент / премиум-клиент',
  },
  {
    marker: 'бедный клиент',
    regex: new RegExp(`${BOL}бедн(?:ый|ого|ому|ым|ом|ые|ых|ыми)\\s+клиент(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'клиент эконом-сегмента',
  },
  {
    marker: 'оказывать услуги',
    regex: new RegExp(`${BOL}оказыва(?:ть|ю|ешь|ет|ем|ете|ют|л|ла|ли|ющ|вш)[а-яё]*\\s+услуг[а-яё]*${EOL}`, 'iu'),
    correction: 'делать дизайн / вести проект',
  },
  {
    marker: 'предоставлять услуги',
    regex: new RegExp(`${BOL}предоставл(?:ять|яю|яешь|яет|яем|яете|яют|ял|яла|яли|яющ|явш)[а-яё]*\\s+услуг[а-яё]*${EOL}`, 'iu'),
    correction: 'делать дизайн / работать с клиентом',
  },
  {
    marker: 'оказание услуг',
    regex: new RegExp(`${BOL}оказани[а-яё]*\\s+услуг[а-яё]*${EOL}`, 'iu'),
    correction: 'работа с клиентом / проектная работа',
  },
  {
    marker: 'осуществлять',
    regex: new RegExp(`${BOL}осуществл(?:ять|яю|яешь|яет|яем|яете|яют|ял|яла|яли|ение|ения|яющ|явш)[а-яё]*${EOL}`, 'iu'),
    correction: 'делать / запускать',
  },
  {
    marker: 'производить (работы/услуги/оплату)',
    regex: new RegExp(`${BOL}производ(?:ить|ишь|ит|им|ите|ят|ил|ила|или|ящ|ивш)[а-яё]*\\s+(?:работ|оплат|расч[её]т|анализ|оценк|услуг)[а-яё]*${EOL}`, 'iu'),
    correction: 'делать / проводить (контекстно)',
  },
  {
    marker: 'дизайн-интерьер (через дефис)',
    regex: new RegExp(`${BOL}дизайн-интерьер(?:а|у|ом|е|ы|ов|ам|ами|ах)?${EOL}`, 'iu'),
    correction: 'дизайн интерьера (без дефиса)',
  },
  {
    marker: 'целевая аудитория',
    regex: new RegExp(`${BOL}целев(?:ая|ой|ую|ые|ыми|ых)\\s+аудитори(?:я|и|ю|ей|ями|ях|ями)?${EOL}`, 'iu'),
    correction: 'аудитория / клиенты',
  },
  {
    marker: 'ЦА (сокращение)',
    // Только заглавные «ЦА» как сокращение, не путать с «ца» внутри других слов
    regex: /(?<![А-ЯЁа-яё\w])ЦА(?![А-ЯЁа-яё\w])/u,
    correction: 'аудитория',
  },
];

// КУРАТОР-КОНСТРУКЦИИ — нарушение роли Виктории.
// v3 (2026-06-03): Виктория = УЧАСТНИЦА клуба, не куратор/наставник.
// Применяется ТОЛЬКО к voice='RZ'.
// При обнаружении в RZ-тексте — отбраковка + retry с инструкцией «пиши от первого лица о СЕБЕ».
export const RZ_CURATOR_FORBIDDEN_PATTERNS: ReadonlyArray<{ marker: string; regex: RegExp; correction: string }> = [
  {
    marker: 'я разбирала с …',
    regex: new RegExp(`${BOL}(?:я|мы)\\s+разбира(?:ла|л|ли|ем)[а-яё]*\\s+(?:с|у)\\s+[А-ЯЁ][а-яё]+`, 'iu'),
    correction: 'переформулируй от первого лица: «На встрече разбирали мою / Катину ситуацию» — но как зеркало для собственной истории',
  },
  {
    marker: 'мы с участницами клуба',
    regex: new RegExp(`${BOL}мы\\s+с\\s+(?:участниц|девочк|резидентк)[а-яё]+\\s+(?:клуб|реализ)`, 'iu'),
    correction: 'это позиция куратора. Виктория = одна из участниц, не «мы с ними»',
  },
  {
    marker: 'многие дизайнеры верят/думают',
    regex: new RegExp(`${BOL}мног(?:ие|их|ими)\\s+дизайнер[а-яё]+\\s+(?:верят|думают|считают|искренне)`, 'iu'),
    correction: 'не обобщай. Расскажи СВОЮ конкретную историю — «Я верила что…», «Я думала что…»',
  },
  {
    marker: 'и вот что я хочу сказать каждой',
    regex: new RegExp(`${BOL}(?:и\\s+)?вот\\s+что\\s+я\\s+(?:хочу|хотела)\\s+сказать`, 'iu'),
    correction: 'это нравоучение. Замени на личное наблюдение или вопрос подписчице',
  },
  {
    marker: 'я наставница / куратор / веду клуб',
    regex: new RegExp(`${BOL}я\\s+(?:наставниц|куратор|веду\\s+клуб|являюсь\\s+(?:наставниц|куратор))`, 'iu'),
    correction: 'Виктория — участница, а не наставница. Она проходит трансформацию изнутри',
  },
  {
    marker: 'знаешь что я заметила',
    regex: new RegExp(`${BOL}знаешь\\s+что\\s+я\\s+заметила`, 'iu'),
    correction: 'звучит как наставник со стороны. Замени на собственную ситуацию: «Я долго думала что…», «Я держалась за…»',
  },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Стемминг по-русски — отдельная задача; здесь используем case-insensitive
// подстроку с учётом ё/е и lower-case нормализацией.
// TODO confirm with Yuri: нужна ли морфология (mystem) или достаточно lowercase?
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е');
}

// Левая граница слова — символ перед маркером не должен быть буквой/цифрой.
// Правая часть не ограничена, чтобы захватывать словоформы: «смотри»→«смотришь»,
// «применила»→«применила» (точное совпадение), «погнали»→«погнали».
// «смотри» НЕ матчится внутри «рассмотрим» (слева буква «с»).
function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (needle.length === 0) return positions;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}`, 'gu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    positions.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++; // защита от пустого матча
  }
  return positions;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  // \p{L}\p{N} — буквы/цифры в любых юникод-алфавитах (включая кириллицу)
  const tokens = trimmed.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
  return tokens ? tokens.length : 0;
}

export interface ValidateInput {
  text: string;
  voice: VoiceCode;
  markers?: VoiceMarkers;
  minDensity?: number;
}

export function validateVoice(input: ValidateInput): VoiceValidatorReport {
  const { text, voice } = input;
  const minDensity = input.minDensity ?? DEFAULT_MIN_DENSITY;
  const markers = input.markers ?? (voice === 'YE' ? YE_MARKERS : RZ_MARKERS);

  const normalized = normalize(text);
  const wordCount = countWords(text);

  const violations: ForbiddenHit[] = [];
  for (const marker of markers.forbidden) {
    const positions = findAllOccurrences(normalized, normalize(marker));
    if (positions.length > 0) {
      violations.push({ marker, positions });
    }
  }

  // Sacred rule #11: упоминание цены клуба в контенте — отбраковка.
  for (const { marker, regex } of PRICE_PATTERNS) {
    const positions: number[] = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      positions.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (positions.length > 0) {
      violations.push({ marker: `цена клуба (sacred rule #11: ${marker})`, positions });
    }
  }

  // Профессиональные ошибки в речи дизайнера-наставника — критическая отбраковка.
  // «Дорогой чек», «дешёвый клиент», «оказывать услуги» = непрофессионал.
  for (const { marker, regex, correction } of PROFESSIONAL_ERROR_PATTERNS) {
    const positions: number[] = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      positions.push(m.index);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (positions.length > 0) {
      violations.push({ marker: `профошибка: "${marker}" → используй: ${correction}`, positions });
    }
  }

  // RZ ТОЛЬКО: куратор-конструкции (Виктория = участница клуба, не куратор).
  if (voice === 'RZ') {
    for (const { marker, regex, correction } of RZ_CURATOR_FORBIDDEN_PATTERNS) {
      const positions: number[] = [];
      const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        positions.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (positions.length > 0) {
        violations.push({ marker: `куратор-голос (нарушает роль Виктории): "${marker}" → ${correction}`, positions });
      }
    }
  }

  const requiredHits: RequiredHit[] = [];
  const missingMarkers: string[] = [];
  let totalRequiredHits = 0;

  for (const marker of markers.required) {
    const positions = findAllOccurrences(normalized, normalize(marker));
    if (positions.length === 0) {
      missingMarkers.push(marker);
    } else {
      requiredHits.push({ marker, count: positions.length });
      totalRequiredHits += positions.length;
    }
  }

  const density =
    wordCount === 0 ? 0 : Number(((totalRequiredHits / wordCount) * 100).toFixed(3));

  let ok = violations.length === 0 && density >= minDensity;
  let reason: string | undefined;
  let suggestion: string | undefined;

  if (!ok) {
    if (violations.length > 0) {
      const names = violations.map((v) => v.marker).join(', ');
      reason = `forbidden markers found: ${names}`;
      suggestion = `replace marketing clichés (${names}) with живые формулировки в голосе ${voice}`;
    } else if (density < minDensity) {
      reason = `required marker density ${density} < ${minDensity}/100w`;
      suggestion = `add natural occurrences of ${voice}-маркеров (e.g. ${markers.required.slice(0, 3).join(', ')})`;
    }
  }

  if (wordCount === 0) {
    ok = false;
    reason = 'empty text';
  }

  const report: VoiceValidatorReport = {
    voice_code: voice,
    ok,
    violations,
    missingMarkers,
    required_markers_found: requiredHits,
    density_per_100w: density,
    score: density,
    word_count: wordCount,
  };
  if (reason !== undefined) report.reason = reason;
  if (suggestion !== undefined) report.suggestion = suggestion;
  return report;
}
