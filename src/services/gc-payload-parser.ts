// Гибкий парсер GetCourse payload (raw_payload из getcourse_raw_events).
// Ищет нужные поля по нескольким возможным именам — формат GC иногда меняется,
// поля могут быть как плоские (event/payment_amount/user_email), так и вложенные.
//
// CLAUDE.md §4 (sacred): деньги ВСЕГДА в копейках. payment_amount в рублях → ×100.

/** Маппинг event'а GC → внутренний тип события. */
export function mapGcEventToType(gcEvent: string | null | undefined): string {
  if (!gcEvent) return 'unknown';
  const e = gcEvent.toLowerCase();
  if (
    e === 'payment_succeeded' ||
    e === 'purchase_completed' ||
    e === 'deal.success' ||
    e === 'deal_success'
  )
    return 'club_purchased';
  if (e === 'payment_refunded' || e === 'deal.refund' || e === 'deal_refund')
    return 'club_refunded';
  return `gc_${e}`;
}

/** Рубли → копейки (integer). Защищён от строк/null/пустоты/запятой. */
export function rublesToKopecks(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Эвристика суммы: если число большое (>= 10000) и без дробной части —
 * предполагаем что уже копейки (GC иногда шлёт `cost_money` так).
 * Иначе считаем рублями и умножаем на 100.
 *
 * ТЗ Юрия 2026-06-08 (наследие ye-ambassador-bot):
 * GC шлёт payed_money в человеческом формате — может быть "5 000 руб.",
 * "5000,50 руб", "1 234,56₽", "RUB 750", число. Включает nbsp (U+00A0)
 * и тонкие пробелы (U+2009). Все эти варианты конвертируем в копейки.
 */
export function smartAmountToKopecks(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    // Если число большое целое — возможно уже копейки
    if (v >= 10000 && Number.isInteger(v)) return Math.round(v);
    return Math.round(v * 100);
  }
  if (typeof v !== 'string') return 0;
  const raw = v.trim();
  if (!raw) return 0;
  // Защитное очищение: убираем словесные единицы валюты, символы валюты, все виды пробелов.
  const cleaned = raw
    .replace(/[A-Za-zА-Яа-яёЁ.]+\s*$/u, '') // хвостовая буквенная единица "руб.", "rub", "₽"
    .replace(/[A-Za-zА-Яа-яёЁ]/gu, '') // оставшиеся буквы внутри
    .replace(/[\u00A0\u2009 ₽$€]/g, '') // nbsp + thin space + обычный space + валюта
    .replace(',', '.');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  const hasFraction = /[.]/.test(cleaned);
  // С дробью = рубли → ×100. Целое >=10000 = подозрительно много для RUB → возможно копейки.
  if (!hasFraction && n >= 10000 && Number.isInteger(n)) return Math.round(n);
  return Math.round(n * 100);
}

/**
 * Парсер дат от GetCourse. Возвращает ISO UTC.
 *
 * Поддерживаемые форматы:
 *   - "2026-06-08T15:04:23Z" / "2026-06-08T15:04:23+00:00"  → ISO
 *   - "2026-06-08 15:04:23"                                  → SQL МСК (UTC+3)
 *   - "08.06.2026 14:46"                                     → русский МСК, без секунд
 *   - "08.06.2026  14:46"                                    → двойной пробел
 *   - "08.06.2026"                                           → только дата, начало суток МСК
 *   - "" / null / "0000-00-00 00:00:00"                      → null (переменная не подставилась)
 *
 * При невалидном вводе → null (вызывающий код решает: now() или ошибка).
 */
export function parseGcDate(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const s = String(input).trim().replace(/\s+/g, ' ');
  if (!s || s.startsWith('0000-00-00') || s === '0000-00-00 00:00:00') return null;

  // URL-кодированный плюс TZ: "2026-05-23T11:58:13 00:00" → "+00:00"
  // Проверяем ДО общего ISO потому что пробел в TZ ломает new Date(...).
  const isoTzFixed = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}) (\d{2}:\d{2})$/);
  if (isoTzFixed) {
    const d = new Date(`${isoTzFixed[1]}+${isoTzFixed[2]}`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // ISO с TZ
  if (/T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // SQL формат МСК (UTC+3): "YYYY-MM-DD HH:MM[:SS]"
  const sql = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (sql) {
    const [, y, mo, d, h, mi, sec] = sql;
    return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! - 3, +mi!, +(sec ?? 0))).toISOString();
  }
  // Русский МСК: "DD.MM.YYYY HH:MM[:SS]"
  const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (ru) {
    const [, d, mo, y, h, mi, sec] = ru;
    return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! - 3, +mi!, +(sec ?? 0))).toISOString();
  }
  // Только дата "DD.MM.YYYY" → начало суток МСК
  const ruDate = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ruDate) {
    const [, d, mo, y] = ruDate;
    return new Date(Date.UTC(+y!, +mo! - 1, +d!, -3, 0, 0)).toISOString();
  }
  // Не распарсили — лучше null чем мусор
  return null;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

// Оставлено как util для будущих fields (по факту parseGcPayload использует
// прямой obj[...] и smartAmountToKopecks; pickNumber доступен для расширения).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v.replace(',', '.').trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export interface GcParsedPayment {
  event: string;
  /** Внутренний тип события (mapGcEventToType). */
  eventType: string;
  paymentId: string | null;
  productId: string | null;
  productName: string | null;
  amountKopecks: number;
  currency: string;
  paidAt: string | null;
  userId: string | null;
  userEmail: string | null;
  userPhone: string | null;
  userFullName: string | null;
  utmSource: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  /** true если payload не содержит явных GC-полей → событие игнорируем. */
  empty: boolean;
}

/** Извлекает поля из произвольного raw_payload (плоский или legacy вложенный). */
export function parseGcPayload(raw: unknown): GcParsedPayment {
  // GC иногда шлёт строку JSON в form-urlencoded поле — пробуем распарсить.
  let obj: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') obj = raw as Record<string, unknown>;
  else if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') obj = j as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }

  // legacy вложенный: { action, deal: { id, user, amount } }
  const deal =
    typeof obj.deal === 'object' && obj.deal !== null ? (obj.deal as Record<string, unknown>) : {};
  const dealUser =
    typeof deal.user === 'object' && deal.user !== null
      ? (deal.user as Record<string, unknown>)
      : {};
  const dealUtm =
    typeof deal.utm === 'object' && deal.utm !== null
      ? (deal.utm as Record<string, unknown>)
      : {};
  // legacy вложенный user/order
  const orderObj =
    typeof obj.order === 'object' && obj.order !== null
      ? (obj.order as Record<string, unknown>)
      : {};
  const userObj =
    typeof obj.user === 'object' && obj.user !== null
      ? (obj.user as Record<string, unknown>)
      : {};

  const event =
    pickString(obj, ['event', 'action', 'status']) ??
    pickString(deal, ['status']) ??
    'unknown';

  const paymentId = pickString(obj, [
    'payment_id',
    'order_id',
    'deal_id',
    'transaction_id',
    'id',
  ]) ?? pickString(deal, ['id']) ?? pickString(orderObj, ['id']);

  const productId = pickString(obj, [
    'product_id',
    'offer_id',
    'order_offer_id',
  ]) ?? pickString(deal, ['offer_id']) ?? pickString(orderObj, ['offer_id', 'product_id']);

  const productName = pickString(obj, [
    'product_name',
    'offer_name',
    'order_offer_name',
  ]) ?? pickString(orderObj, ['offer_name', 'product_name']);

  // Сырое значение суммы (может быть рубли или копейки — определяем эвристикой ниже).
  const amountRaw =
    obj['payment_amount'] ??
    obj['amount'] ??
    obj['cost_money'] ??
    obj['order_amount'] ??
    obj['total'] ??
    obj['sum'] ??
    (deal as Record<string, unknown>)['amount'] ??
    (orderObj as Record<string, unknown>)['amount'] ??
    (orderObj as Record<string, unknown>)['total'];

  const currency =
    pickString(obj, ['payment_currency', 'currency']) ??
    pickString(deal, ['currency']) ??
    'RUB';

  const paidAtRaw =
    pickString(obj, ['payment_paid_at', 'paid_at', 'payment_date', 'payed_at', 'deal_payed_at']) ??
    pickString(deal, ['paid_at', 'payed_at']) ??
    null;
  // ТЗ 2026-06-08: paid_at может быть в любом из 6 форматов (ISO/SQL/русский с/без секунд/пробелов).
  // parseGcDate возвращает ISO UTC или null при невалидном вводе.
  // Fallback на raw value сохраняем для backward-compat если parseGcDate не справился.
  const paidAt = parseGcDate(paidAtRaw) ?? paidAtRaw;

  const userId =
    pickString(obj, ['user_id', 'gc_user_id', 'customer_id']) ??
    pickString(userObj, ['id']);

  const userEmail =
    pickString(obj, ['user_email', 'email', 'customer_email']) ??
    pickString(userObj, ['email']) ??
    pickString(dealUser, ['email']);

  const userPhone =
    pickString(obj, ['user_phone', 'phone', 'customer_phone']) ??
    pickString(userObj, ['phone']) ??
    pickString(dealUser, ['phone']);

  const userFullName =
    pickString(obj, ['user_full_name', 'user_name', 'fio', 'customer_name', 'full_name']) ??
    pickString(userObj, ['full_name', 'name']) ??
    pickString(dealUser, ['first_name']);

  const utmSource = pickString(obj, ['utm_source']) ?? pickString(dealUtm, ['utm_source', 'source']);
  const utmCampaign =
    pickString(obj, ['utm_campaign']) ?? pickString(dealUtm, ['utm_campaign', 'campaign']);
  const utmContent =
    pickString(obj, ['utm_content']) ?? pickString(dealUtm, ['utm_content', 'content']);

  const hasAnyField = Boolean(
    paymentId || productId || amountRaw !== undefined || userEmail || userId || event !== 'unknown',
  );

  return {
    event,
    eventType: mapGcEventToType(event),
    paymentId,
    productId,
    productName,
    amountKopecks: smartAmountToKopecks(amountRaw),
    currency,
    paidAt,
    userId,
    userEmail,
    userPhone,
    userFullName,
    utmSource,
    utmCampaign,
    utmContent,
    empty: !hasAnyField,
  };
}

/** Принадлежит ли парсенное событие нашему клубу. */
export interface ClubMatchOptions {
  /** legacy: одиночный ID; если задан и совпадает с productId — это клуб */
  baseOfferId: string | null;
  /** новый: список ID клубных предложений (CSV из env CLUB_OFFER_IDS) */
  clubOfferIds?: readonly string[];
  /** новый: substring (case-insensitive) для матчинга по имени предложения */
  clubOfferNameMatch?: string;
}

export function isClubPayment(parsed: GcParsedPayment, opts: ClubMatchOptions | string | null): boolean {
  if (parsed.eventType !== 'club_purchased') return false;
  // backward compat: если передали строку — это baseOfferId
  const o: ClubMatchOptions =
    typeof opts === 'string' || opts === null
      ? { baseOfferId: opts }
      : opts;
  // 1) совпадение по списку клубных offer IDs (новый путь)
  if (o.clubOfferIds && o.clubOfferIds.length > 0 && parsed.productId && o.clubOfferIds.includes(parsed.productId)) {
    return true;
  }
  // 2) legacy baseOfferId
  if (o.baseOfferId && parsed.productId === o.baseOfferId) return true;
  // 3) fallback по имени предложения
  if (o.clubOfferNameMatch && parsed.productName) {
    const needle = o.clubOfferNameMatch.toLowerCase();
    if (parsed.productName.toLowerCase().includes(needle)) return true;
  }
  // 4) если вообще никакой фильтр не задан и это club_purchased — принимаем (старое поведение)
  if (!o.clubOfferIds?.length && !o.baseOfferId && !o.clubOfferNameMatch) return true;
  return false;
}
void pickNumber;
