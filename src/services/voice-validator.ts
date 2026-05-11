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
  required: [
    'угу',
    'вот',
    'то есть',
    'погнали',
    'слушай',
    'короче говоря',
    'давай по делу',
    'смотри',
  ],
  forbidden: [
    'УТП',
    'возражения',
    'синергия',
    'целевая аудитория',
    'хочу поделиться',
    'дорогие подписчики',
    'эксклюзивное предложение',
    'не упустите шанс',
    'успех гарантирован',
    'следует учитывать',
    'необходимо понимать',
  ],
};

export const RZ_MARKERS: VoiceMarkers = {
  required: [
    'я',
    'у меня',
    'мы',
    'в клубе',
    'разобрали',
    'получилось',
    'применила',
    'честно говоря',
    'если коротко',
  ],
  forbidden: [
    'УТП',
    'возражения',
    'синергия',
    'целевая аудитория',
    'хочу поделиться',
    'дорогие подписчики',
    'эксклюзивное предложение',
    'не упустите шанс',
    'погнали',
    'братская могила',
    'болото',
    'дом на курьих ножках',
  ],
};

export const DEFAULT_MIN_DENSITY = 0.3; // markers per 100 words, см. SPEC AC-14

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
