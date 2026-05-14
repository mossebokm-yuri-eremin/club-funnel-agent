// approval-notifier — отправка готового контент-пакета Юрию в Telegram
// после рендера каруселей (carousel-worker). SPEC §2.8 AC-22 — упрощённая
// версия: текст + 3 первых слайда альбомом. Кнопки одобрения — Phase 7.

import type { Pool } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const tgApi = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

const ContentPackageRowSchema = z.object({
  id: z.string(),
  idea_id: z.string(),
  reel_caption: z.string(),
  tg_post: z.string(),
  carousel_slides: z.unknown(),
  assets: z.unknown(),
});

const IdeaRowSchema = z.object({
  id: z.string(),
  summary: z.string().nullable(),
  pain_tag: z.string().nullable(),
  strategy: z.string().nullable(),
});

interface SlidesMeta {
  slides?: string[];
  slides_meta?: Array<{ index: number; url: string; source: string; public_id: string }>;
}

function extractSlideUrls(assets: unknown): string[] {
  if (!assets || typeof assets !== 'object') return [];
  const a = assets as SlidesMeta;
  if (Array.isArray(a.slides)) return a.slides;
  if (Array.isArray(a.slides_meta)) return a.slides_meta.map((s) => s.url);
  return [];
}

function extractSlideTexts(slides: unknown): string[] {
  if (!Array.isArray(slides)) return [];
  return slides
    .map((s) => {
      if (typeof s === 'string') return s;
      if (s && typeof s === 'object') {
        const obj = s as { text?: unknown; body?: unknown; content?: unknown };
        if (typeof obj.text === 'string') return obj.text;
        if (typeof obj.body === 'string') return obj.body;
        if (typeof obj.content === 'string') return obj.content;
      }
      return '';
    })
    .filter((t) => t.length > 0);
}

function formatCarouselText(texts: string[]): string | null {
  if (texts.length === 0) return null;
  const head = `🎴 ТЕКСТ КАРУСЕЛИ (${texts.length} слайдов):\n\n`;
  const body = texts
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n\n')
    .slice(0, 3800);
  return head + body;
}

export interface NotifyApprovalInput {
  contentPackageId: string;
  /** TG chat_id куда слать. По умолчанию = config.YE_TG_USER_ID. */
  chatId?: number;
}

export interface NotifyApprovalDeps {
  pool: Pool;
  fetchFn?: typeof fetch;
}

export async function notifyApprovalReady(
  input: NotifyApprovalInput,
  deps: NotifyApprovalDeps,
): Promise<{ status: 'ok' | 'skipped'; reason?: string }> {
  const token = config.TELEGRAM_BOT_TOKEN;
  const chatId = input.chatId ?? config.YE_TG_USER_ID;
  if (!chatId || chatId === 0) {
    log.warn({}, 'approval-notifier: YE_TG_USER_ID not set, skipping');
    return { status: 'skipped', reason: 'YE_TG_USER_ID not set' };
  }
  const fetchFn = deps.fetchFn ?? fetch;

  const pkgRes = await deps.pool.query(
    `SELECT id, idea_id, reel_caption, tg_post, carousel_slides, assets
       FROM content_packages WHERE id = $1`,
    [input.contentPackageId],
  );
  const pkg = ContentPackageRowSchema.safeParse(pkgRes.rows[0]);
  if (!pkg.success) {
    return { status: 'skipped', reason: 'content_package not found or invalid' };
  }
  const ideaRes = await deps.pool.query(
    `SELECT id, summary, pain_tag, strategy FROM ideas WHERE id = $1`,
    [pkg.data.idea_id],
  );
  const idea = IdeaRowSchema.safeParse(ideaRes.rows[0]);
  if (!idea.success) {
    return { status: 'skipped', reason: 'idea not found' };
  }

  const slideUrls = extractSlideUrls(pkg.data.assets);
  const slideTexts = extractSlideTexts(pkg.data.carousel_slides);

  // Сообщение 1: краткое резюме идеи + рилс-описание
  const header =
    `🎯 Готов пакет на согласование\n\n` +
    `💡 Идея: ${idea.data.summary ?? '(нет summary)'}\n` +
    `🏷 Боль: ${idea.data.pain_tag ?? '(нет)'}\n` +
    `🎲 Стратегия: ${idea.data.strategy ?? '(не выбрана)'}\n\n` +
    `📹 РИЛС:\n${pkg.data.reel_caption.slice(0, 1500)}`;

  // Сообщение 2: пост в TG
  const postMsg = `📝 ПОСТ В TG:\n${pkg.data.tg_post.slice(0, 3500)}`;

  // Сообщение 3: текст слайдов карусели (нумерованный) — чтобы было читаемо
  // даже если картинки placeholder/недоступны.
  const slidesTextMsg = formatCarouselText(slideTexts);

  await sendMessage(fetchFn, token, chatId, header);
  await sendMessage(fetchFn, token, chatId, postMsg);
  if (slidesTextMsg) await sendMessage(fetchFn, token, chatId, slidesTextMsg);
  // Сообщение 4: альбом картинок карусели (если есть)
  if (slideUrls.length > 0) {
    await sendMediaGroup(fetchFn, token, chatId, slideUrls.slice(0, 10));
  }
  await sendMessage(
    fetchFn,
    token,
    chatId,
    `✅ content_package_id: \`${pkg.data.id}\`\n\nВыбери действие ниже.`,
    'Markdown',
    buildApprovalKeyboard(pkg.data.id),
  );

  log.info(
    {
      contentPackageId: pkg.data.id,
      ideaId: idea.data.id,
      slideCount: slideUrls.length,
    },
    'approval-notifier: notification sent',
  );
  return { status: 'ok' };
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function buildApprovalKeyboard(pkgId: string): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '✅ Одобрить', callback_data: `cp:approve:${pkgId}` },
        { text: '🔄 Перегенерировать', callback_data: `cp:regen:${pkgId}` },
      ],
      [
        { text: '✏️ Правка', callback_data: `cp:edit:${pkgId}` },
        { text: '✖ Отклонить', callback_data: `cp:reject:${pkgId}` },
      ],
    ],
  };
}

async function sendMessage(
  fetchFn: typeof fetch,
  token: string,
  chatId: number,
  text: string,
  parseMode?: 'Markdown' | 'HTML',
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetchFn(tgApi(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '<unreadable>');
    log.warn(
      { status: res.status, response: t.slice(0, 200) },
      'approval-notifier: sendMessage failed',
    );
  }
}

async function sendMediaGroup(
  fetchFn: typeof fetch,
  token: string,
  chatId: number,
  urls: string[],
): Promise<void> {
  if (urls.length === 0) return;
  const media = urls.map((url, i) => ({
    type: 'photo',
    media: url,
    ...(i === 0 ? { caption: '🖼 Карусель' } : {}),
  }));
  const res = await fetchFn(tgApi(token, 'sendMediaGroup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, media }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '<unreadable>');
    log.warn(
      { status: res.status, response: t.slice(0, 300) },
      'approval-notifier: sendMediaGroup failed',
    );
  }
}
