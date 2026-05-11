// SPEC §2.13 AC-38 + §6.4 — детектор пересланных Reels/постов из Instagram
// в Telegram-бота. Чистая функция: тестируется без grammY-контекста.

export type ReferenceSource =
  | 'ig_url'                   // явный URL instagram.com/(reel|p|tv|reels)/...
  | 'forward_ig_channel'       // forward_origin.type='channel' через IG-bridge канал
  | 'ig_bridge_bot'            // via_bot из списка известных IG-bridge ботов
  | 'media_forward_no_caption'; // video/photo переслан без caption

export interface ReferenceDetection {
  isReference: boolean;
  source: ReferenceSource | null;
  confidence: number; // 0..1
  reasons: string[];
  mediaUrl?: string;
  captionText?: string;
}

// Структурный тип сообщения. Совместим с Telegram Message из @grammyjs/types,
// но без жёсткой зависимости — детектор должен оставаться чистым.
export interface MessageEntityLike {
  type: string;
  offset: number;
  length: number;
  url?: string;
}

// MessageOriginLike — структурно-совместимый супертип Telegram MessageOrigin.
// Поля заданы как `T | undefined`, чтобы exactOptionalPropertyTypes не мешал
// присваивать сюда полный MessageOrigin из @grammyjs/types.
export type MessageOriginLike =
  | { type: 'user'; date?: number | undefined; sender_user?: { id?: number; username?: string | undefined } | undefined }
  | { type: 'hidden_user'; date?: number | undefined; sender_user_name?: string | undefined }
  | { type: 'chat'; date?: number | undefined; sender_chat?: { id?: number; username?: string | undefined; title?: string | undefined } | undefined }
  | { type: 'channel'; date?: number | undefined; chat?: { id?: number; username?: string | undefined; title?: string | undefined } | undefined };

export interface DetectableMessage {
  message_id?: number;
  text?: string;
  caption?: string;
  entities?: ReadonlyArray<MessageEntityLike>;
  caption_entities?: ReadonlyArray<MessageEntityLike>;
  forward_origin?: MessageOriginLike;
  video?: unknown;
  animation?: unknown;
  photo?: ReadonlyArray<unknown>;
  document?: { mime_type?: string } | unknown;
  via_bot?: { username?: string };
}

// instagram.com/{reel,reels,p,tv}/{shortcode}/?...
// Поддерживаем www. и без, http/https, без схемы (entities иногда без https://),
// а также www.instagram.com.
const IG_URL_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(reel|reels|p|tv)\/[A-Za-z0-9_-]+/i;

// IG-bridge каналы — несколько известных пабликов-мостов, которые
// автоматически постят IG в TG. SPEC §6.4 упоминает chat.username с 'insta'.
const IG_BRIDGE_CHANNEL_PATTERNS: ReadonlyArray<RegExp> = [
  /insta/i,
  /^ig_/i,
];

// IG-bridge боты — список расширяется по мере встреч.
// Юзернеймы без префикса @, lower-case при сравнении.
export const IG_BRIDGE_BOTS: ReadonlyArray<string> = [
  'fetchuploaderbot',
  'instasavebot',
  'idownload_videos_bot',
  'savefrombot',
  'igmediabot',
  'reelsaver_bot',
];

export interface DetectOptions {
  /** Расширить дефолтный список IG-bridge ботов. */
  extraBridgeBots?: ReadonlyArray<string>;
}

function findIgUrlInEntities(
  text: string | undefined,
  entities: ReadonlyArray<MessageEntityLike> | undefined,
): string | undefined {
  if (!entities || entities.length === 0) return undefined;
  for (const e of entities) {
    if (e.type === 'text_link' && e.url && IG_URL_RE.test(e.url)) return e.url;
    if (e.type === 'url' && text) {
      const slice = text.slice(e.offset, e.offset + e.length);
      if (IG_URL_RE.test(slice)) return slice;
    }
  }
  return undefined;
}

function findIgUrlInPlain(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(IG_URL_RE);
  return m ? m[0] : undefined;
}

function hasMedia(m: DetectableMessage): boolean {
  if (m.video) return true;
  if (m.animation) return true;
  if (Array.isArray(m.photo) && m.photo.length > 0) return true;
  const doc = m.document as { mime_type?: string } | undefined;
  if (doc && typeof doc === 'object' && typeof doc.mime_type === 'string') {
    if (doc.mime_type.startsWith('video/') || doc.mime_type.startsWith('image/')) return true;
  }
  return false;
}

function isIgBridgeChannel(origin: MessageOriginLike | undefined): boolean {
  if (!origin || origin.type !== 'channel') return false;
  const u = origin.chat?.username;
  if (!u) return false;
  return IG_BRIDGE_CHANNEL_PATTERNS.some((re) => re.test(u));
}

export function detectReference(
  msg: DetectableMessage,
  opts: DetectOptions = {},
): ReferenceDetection {
  const reasons: string[] = [];
  const captionText = msg.caption ?? msg.text;

  // (a) явный URL Instagram
  const igUrl =
    findIgUrlInEntities(msg.text, msg.entities) ??
    findIgUrlInEntities(msg.caption, msg.caption_entities) ??
    findIgUrlInPlain(msg.text) ??
    findIgUrlInPlain(msg.caption);

  // (b) forward_origin из IG-bridge канала
  const fromIgChannel = isIgBridgeChannel(msg.forward_origin);

  // (d) via_bot из списка IG-bridge ботов
  const bridgeBots = new Set(
    [...IG_BRIDGE_BOTS, ...(opts.extraBridgeBots ?? [])].map((s) => s.toLowerCase()),
  );
  const viaBot = msg.via_bot?.username?.toLowerCase();
  const fromBridgeBot = Boolean(viaBot && bridgeBots.has(viaBot));

  // (c) media + forward_origin без caption
  const hasFwd = Boolean(msg.forward_origin);
  const noCaption = !msg.caption || msg.caption.trim() === '';
  const mediaForwardNoCaption = hasFwd && hasMedia(msg) && noCaption;

  // Приоритизация источника: явный URL → bridge bot → forward IG канал → media forward.
  // Confidence отражает уверенность сигнала, а не композицию.
  let source: ReferenceSource | null = null;
  let confidence = 0;

  if (igUrl) {
    source = 'ig_url';
    confidence = 0.95;
    reasons.push(`ig_url:${igUrl}`);
  } else if (fromBridgeBot) {
    source = 'ig_bridge_bot';
    confidence = 0.85;
    reasons.push(`bridge_bot:${viaBot ?? ''}`);
  } else if (fromIgChannel) {
    source = 'forward_ig_channel';
    confidence = 0.9;
    const u = (msg.forward_origin as { chat?: { username?: string } } | undefined)?.chat?.username;
    reasons.push(`fwd_channel:${u ?? ''}`);
  } else if (mediaForwardNoCaption) {
    source = 'media_forward_no_caption';
    confidence = 0.6;
    reasons.push('media_forward_no_caption');
  }

  const isReference = source !== null;

  const result: ReferenceDetection = {
    isReference,
    source,
    confidence,
    reasons,
  };
  if (igUrl) result.mediaUrl = igUrl;
  if (captionText) result.captionText = captionText;
  return result;
}
