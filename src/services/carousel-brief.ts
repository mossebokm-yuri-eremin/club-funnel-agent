// carousel-brief — генерация подробного markdown-ТЗ карусели для дизайнера/Claude Design.
//
// Входы:
//   contentPackageId — UUID из content_packages
//   pool             — postgres
//
// Источники данных:
//   content_packages.carousel_slides (JSONB array слайдов с текстом)
//   content_packages.assets          (ig_caption, ig_code_word — кеш после approve)
//   ideas.summary, ideas.pain_tag, ideas.strategy
//
// Выход:
//   - Markdown с разделами: Контекст / Технические требования / Слайды 1..N /
//     Фирменный стиль / Финальный чек-лист.
//   - Пишется в /var/www/cdn/briefs/{pkgId}.md, отдаётся через nginx alias /cdn/.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const BRIEFS_DIR = '/var/www/cdn/briefs';

export interface CarouselBriefInput {
  contentPackageId: string;
}

export interface CarouselBriefDeps {
  pool: Pool;
}

export interface CarouselBriefResult {
  status: 'ok' | 'skipped' | 'error';
  url?: string;
  path?: string;
  bytes?: number;
  reason?: string;
}

interface SlideText {
  index: number;
  text: string;
  hint?: string;
}

function extractSlideTexts(raw: unknown): SlideText[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s, i) => {
    if (typeof s === 'string') return { index: i + 1, text: s };
    if (s && typeof s === 'object') {
      const obj = s as Record<string, unknown>;
      const text = typeof obj['text'] === 'string' ? (obj['text'] as string) : '';
      const hint = typeof obj['hint'] === 'string' ? (obj['hint'] as string) : undefined;
      return hint
        ? { index: i + 1, text, hint }
        : { index: i + 1, text };
    }
    return { index: i + 1, text: '' };
  });
}

function pickCaption(assets: unknown): { caption: string | null; codeWord: string | null } {
  if (!assets || typeof assets !== 'object') return { caption: null, codeWord: null };
  const a = assets as Record<string, unknown>;
  return {
    caption: typeof a['ig_caption'] === 'string' ? (a['ig_caption'] as string) : null,
    codeWord: typeof a['ig_code_word'] === 'string' ? (a['ig_code_word'] as string) : null,
  };
}

function slideRole(index: number, total: number): string {
  if (index === 1) return 'хук — ловит внимание за 1 сек';
  if (index === 2) return 'обещание — что узнает читатель';
  if (index === total) return 'финал-CTA — призыв написать code_word в Direct';
  if (index === total - 1) return 'обоснование действия (если N≥9)';
  return 'разбор / факт / шаг';
}

function visualHint(index: number, total: number): string {
  if (index === 1) {
    return '— Хук-кадр Юрия. Лицо крупным планом, прямой взгляд в камеру.\n' +
           '  Фон тёмный (gradient #0F1A2A → #1B2E4A).\n' +
           '  Текст сверху белым 64px (system-font), выделение жёлтым #F2C94C.';
  }
  if (index === total) {
    return '— Финал-слайд. Code_word крупно в центре (96px), белым на тёмном фоне.\n' +
           '  Внизу мелким (24px): «напиши это слово в Direct → @yurii.eremin».';
  }
  return '— Светлая карточка (#F7F4EE) с фото Юрия в angles, текст 48-56px,\n' +
         '  подзаголовок 32px, акценты — жёлтый #F2C94C / синий #1B2E4A.';
}

export async function buildCarouselBriefMarkdown(
  pool: Pool,
  contentPackageId: string,
): Promise<string | null> {
  const pkgRes = await pool.query<{
    id: string;
    idea_id: string;
    reel_caption: string;
    tg_post: string;
    carousel_slides: unknown;
    assets: unknown;
  }>(
    `SELECT id, idea_id, reel_caption, tg_post, carousel_slides, assets
       FROM content_packages WHERE id = $1`,
    [contentPackageId],
  );
  const pkg = pkgRes.rows[0];
  if (!pkg) return null;

  const ideaRes = await pool.query<{
    id: string;
    summary: string | null;
    pain_tag: string | null;
    strategy: 'A' | 'B' | 'C' | null;
  }>(
    `SELECT id, summary, pain_tag, strategy FROM ideas WHERE id = $1`,
    [pkg.idea_id],
  );
  const idea = ideaRes.rows[0];

  const slides = extractSlideTexts(pkg.carousel_slides);
  const { caption, codeWord } = pickCaption(pkg.assets);

  const total = slides.length || 10;
  const today = new Date().toISOString().slice(0, 10);

  const head =
`# ТЗ для дизайнера / Claude Design — карусель Instagram

**Сгенерировано:** ${today}
**content_package_id:** \`${pkg.id}\`
**idea_id:** \`${pkg.idea_id}\`
**Кодовое слово воронки:** ${codeWord ? '`' + codeWord.toUpperCase() + '`' : '(будет добавлено после approve)'}

---

## 1. Контекст идеи

- **Идея:** ${idea?.summary ?? '(нет summary)'}
- **Боль (pain_tag):** ${idea?.pain_tag ?? '(не задана)'}
- **Стратегия:** ${idea?.strategy ?? '(не задана)'} ${idea?.strategy === 'A' ? '— PDF-лонгрид как лид-магнит' : idea?.strategy === 'B' ? '— быстрая карусель → клуб' : idea?.strategy === 'C' ? '— PDF-лонгрид (короткий)' : ''}
- **Аудитория:** дизайнеры интерьеров в начале и середине пути, не выходят за чек 3-5 тыс/м².

---

## 2. Технические требования

- **Размер:** 1080×1350 px (Instagram 4:5)
- **Формат вывода:** PNG (для дизайнера) → JPG q=90 после сборки
- **Количество слайдов:** ${total}
- **Шрифты:** system-stack (San Francisco / Inter) — никаких декоративных
- **Цветовая палитра:**
  - Фон тёмных слайдов: \`#0F1A2A → #1B2E4A\` (vertical gradient)
  - Фон светлых слайдов: \`#F7F4EE\` (тёплый-сливочный)
  - Текст белый: \`#FFFFFF\`
  - Текст тёмный: \`#0F1A2A\`
  - Акцент-жёлтый: \`#F2C94C\` (для ключевых слов / цифр)
  - Акцент-синий: \`#1B2E4A\` (для кнопок / выноски)
- **Watermark:** \`@yury_eremin\` в правом нижнем углу, 24px, белый 95% opacity
- **Безопасная зона:** отступ 64px со всех сторон (Instagram crops верх и низ в feed-preview)

---

## 3. Фото-ассеты Юрия

Используются с Google Drive (folder \`GDRIVE_YE_PHOTO_FILE_ID\`).
Подбирает агент через \`yury-photo-selector.ts\`:
- хук-кадр: лицо крупным планом, серьёзный взгляд
- разбор: жесты, поза учителя/наставника
- финал: открытая поза, прямой взгляд (приглашение в диалог)

---

## 4. Слайды (${total} шт.)

`;

  const slideBlocks = slides.length > 0
    ? slides.map((s) => {
        const role = slideRole(s.index, total);
        const visual = visualHint(s.index, total);
        return `### Слайд ${s.index} из ${total}

**Цель:** ${role}

**Текст слайда:**
> ${s.text || '(пусто — нужно перегенерировать карусель)'}

**Описание визуала:**
${visual}

${s.hint ? `**Подсказка из voice-сэмпла:** ${s.hint}\n` : ''}
---
`;
      }).join('\n')
    : `_Тексты слайдов отсутствуют. Возможно \`carousel-text\` ещё не отработал.
Можно сгенерировать вручную из текста рилса:_

> ${pkg.reel_caption.slice(0, 600)}…
`;

  const tail =
`
## 5. Подпись для публикации в Instagram

\`\`\`
${caption ?? '(подпись будет сгенерирована после ✅ Одобрить)'}
\`\`\`

---

## 6. Финальный чек-лист дизайнера

- [ ] Все ${total} слайдов 1080×1350 PNG
- [ ] Watermark \`@yury_eremin\` 24px есть на каждом
- [ ] Code_word на финале крупно (96px), легко читается
- [ ] Цифры из текстов выделены жёлтым \`#F2C94C\`
- [ ] Безопасная зона 64px соблюдена
- [ ] Нет эмодзи на самих слайдах
- [ ] Лица Юрия — резкие, не размытые

---

_Сгенерировано club-funnel-agent. Скачать снова: ${config.APP_PUBLIC_BASE_URL}/cdn/briefs/${pkg.id}.md_
`;

  return head + slideBlocks + tail;
}

export async function writeCarouselBrief(
  pool: Pool,
  input: CarouselBriefInput,
): Promise<CarouselBriefResult> {
  const md = await buildCarouselBriefMarkdown(pool, input.contentPackageId);
  if (md === null) {
    return { status: 'skipped', reason: 'content_package not found' };
  }
  try {
    await mkdir(BRIEFS_DIR, { recursive: true });
    const path = join(BRIEFS_DIR, `${input.contentPackageId}.md`);
    await writeFile(path, md, 'utf8');
    const url = `${config.APP_PUBLIC_BASE_URL.replace(/\/$/, '')}/cdn/briefs/${input.contentPackageId}.md`;
    log.info({ contentPackageId: input.contentPackageId, path, bytes: md.length }, 'carousel-brief: written');
    return { status: 'ok', url, path, bytes: md.length };
  } catch (err) {
    log.error(
      { err: (err as Error).message, contentPackageId: input.contentPackageId },
      'carousel-brief: write failed',
    );
    return { status: 'error', reason: (err as Error).message };
  }
}
