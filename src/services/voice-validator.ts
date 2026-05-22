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

export const RZ_MARKERS: VoiceMarkers = {
  required: [
    'у нас в клубе',
    'я разбирала',
    'мы с девочками',
    'честно говоря',
    'если коротко',
    'знаешь что',
    'получилось',
    'применила',
    'я',  // личное лицо куратора
  ],
  forbidden: [
    'дело в том',
    'таким образом',
    'следует отметить',
    'возможно',
    'является',
    'осуществляется',
    'дорогие подписчики',
    'дорогие девочки',
    'мои хорошие',
    'зайки',
    'солнышки',
    'УТП',
    'возражения',
    'синергия',
    'целевая аудитория',
    'эксклюзивное предложение',
    'не упустите шанс',
    'успех гарантирован',
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
