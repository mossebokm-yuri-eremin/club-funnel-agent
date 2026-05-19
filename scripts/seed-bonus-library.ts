// scripts/seed-bonus-library.ts
//
// Сеет 5 базовых лонгридов в bonus_library по топ-5 болям ЦА (из
// knowledge/rz-funnel-content/01-audience-portrait.md, секция «3. БОЛИ»).
//
// Для каждой боли:
//   1. Генерим body_md через Claude Opus + LONGREAD_WRITER_SYSTEM_PROMPT.
//   2. Рендерим PDF через Puppeteer + templates/longread.hbs.
//   3. Считаем embedding (text-embedding-3-small, 1536 dim).
//   4. Загружаем PDF в local CDN (/var/www/cdn/bonuses/<slug>.pdf) —
//      доступен по https://agent.yury-eremin.ru/cdn/bonuses/<slug>.pdf.
//   5. INSERT в bonus_library (origin='audience_brain', status='live').
//
// Запуск (после code review Юрием):
//   npx tsx scripts/seed-bonus-library.ts            — все 5 болей
//   npx tsx scripts/seed-bonus-library.ts pricing_fear  — одна конкретная
//   npx tsx scripts/seed-bonus-library.ts --dry-run     — без INSERT, только проверить генерацию
//
// Безопасно повторно: ON CONFLICT — UPDATE (по pain_tag/title).

import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { config } from '../src/config.js';
import { log } from '../src/observability/logger.js';
import { callAnthropic } from '../src/integrations/anthropic.js';
import { LONGREAD_WRITER_SYSTEM_PROMPT } from '../src/prompts/longread-writer.v1.js';
import { createEmbedding } from '../src/integrations/openai.js';

// --- Топ-5 болей -----------------------------------------------------------

interface BonusSpec {
  painTag: string;
  title: string;
  /** Краткое описание боли для подсказки модели (1-2 предложения). */
  painBrief: string;
  /** Код-слово воронки. Используется в шапке/футере лонгрида + в Direct. */
  codeWord: string;
}

const SEED_BONUSES: readonly BonusSpec[] = [
  {
    painTag: 'pricing_fear',
    title:
      'Как перестать стесняться своей цены и подписать договор от 4500 ₽/м² — даже если 3 года работал по 1000',
    painBrief:
      'Дизайнер боится называть свою цену, заранее снижает её, чувствует «неловко просить дорого». При этом проекты и опыт есть — но при словах "стоимость моей работы" внутри ёкает.',
    codeWord: 'ЦЕНА',
  },
  {
    painTag: 'product_pricing',
    title: 'Почему дизайнер с папкой PDF зарабатывает копейки — и как из этого выйти за 8 недель',
    painBrief:
      'Делает проекты на миллионы рублей за реализацию, но себе берёт 50-150 тысяч. Чертежи стоят 5 рублей 2 копейки. Не понимает, что является его продуктом и за что клиент реально платит.',
    codeWord: 'ПРОДУКТ',
  },
  {
    painTag: 'content_results',
    title: 'Instagram-болото: почему рилсы не приносят клиентов и что работает вместо них',
    painBrief:
      'Снимает контент уже год — лайки есть, клиентов нет. Подписчики растут — продажи стоят. «Я сделала всё что могла — рилсов нет результата». Считает что нужно «больше снимать», но дело не в количестве.',
    codeWord: 'РИЛСЫ',
  },
  {
    painTag: 'burnout',
    title: 'Как перестать сидеть до 3 ночи и начать управлять своими проектами, а не тонуть в них',
    painBrief:
      'Работает 12+ часов в сутки, дети уже спят. Третье выгорание. Хочет «выйти на новый уровень», но даже сейчас не справляется. Делает сам всё: чертежи, общение, поиск клиентов, выезды.',
    codeWord: 'СИСТЕМА',
  },
  {
    painTag: 'public_brand',
    title: 'Личный бренд для интровертов: без сторис каждый час и истерики на камеру',
    painBrief:
      'Стесняется выкладывать себя в Instagram. Думает что «нужно быть как все блогеры — танцевать, кричать». Боится хейта от знакомых и коллег. При этом понимает: без личного бренда — нет дорогих клиентов.',
    codeWord: 'ИМЯ',
  },
];

// --- Util --------------------------------------------------------------------

interface CliArgs {
  painFilter: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let painFilter: string | null = null;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (!a.startsWith('-')) painFilter = a;
  }
  return { painFilter, dryRun };
}

function countWords(md: string): number {
  return (md.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []).length;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ё]/g, 'e')
    .replace(/[^a-z0-9а-я]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// --- Generation steps --------------------------------------------------------

async function generateLongread(spec: BonusSpec): Promise<{ bodyMd: string; outline: unknown[] }> {
  const userPrompt = [
    `БОЛЬ ЦЕЛЕВОЙ АУДИТОРИИ: ${spec.painTag}`,
    `КРАТКОЕ ОПИСАНИЕ БОЛИ: ${spec.painBrief}`,
    `ЗАГОЛОВОК ЛОНГРИДА (можешь скорректировать): ${spec.title}`,
    `КОДОВОЕ СЛОВО ВОРОНКИ: ${spec.codeWord}`,
    '',
    'Сгенерируй полный лонгрид по системному промпту (LONGREAD_WRITER).',
    'Объём 1500-2500 слов. Формат — markdown (# H1, ## H2 секции, ### H3 при необходимости).',
    'Минимум 3 личных кейса Юрия с конкретными числами. Метафоры из словаря (Авито/Instagram-болото/чертежи 5 рублей 2 копейки и т.д.).',
    '',
    'Перед лонгридом отдельным блоком — outline (JSON-массив 7 H2-секций с краткими описаниями):',
    '<OUTLINE>',
    '[{"title":"...","summary":"..."}, ...]',
    '</OUTLINE>',
    '',
    'Затем — сам лонгрид в markdown.',
  ].join('\n');

  log.info({ painTag: spec.painTag, model: 'opus-thinking' }, 'seed: generating longread…');

  const r = await callAnthropic({
    mode: 'thinking',
    system: LONGREAD_WRITER_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    traceTag: `seed-bonus:${spec.painTag}`,
    maxTokens: 12000,
  });

  // Парсим <OUTLINE>...</OUTLINE>
  const m = r.text.match(/<OUTLINE>\s*([\s\S]*?)\s*<\/OUTLINE>/);
  let outline: unknown[] = [];
  let bodyMd = r.text.trim();
  if (m && m[1]) {
    try {
      outline = JSON.parse(m[1]);
    } catch {
      outline = [];
    }
    bodyMd = r.text.replace(/<OUTLINE>[\s\S]*?<\/OUTLINE>\s*/, '').trim();
  }
  log.info(
    {
      painTag: spec.painTag,
      words: countWords(bodyMd),
      outlineSections: outline.length,
      cost_usd: r.costUsd,
    },
    'seed: longread done',
  );
  return { bodyMd, outline };
}

async function renderPdf(spec: BonusSpec, bodyMd: string): Promise<Buffer> {
  // Используем существующий рендерер templates/longread.hbs + Puppeteer.
  const Handlebars = (await import('handlebars')).default;
  const md = await import('marked');
  const tplText = await fs.readFile(path.resolve('templates/longread.hbs'), 'utf8');
  const tpl = Handlebars.compile(tplText);
  const html = tpl({
    title: spec.title,
    painTag: spec.painTag,
    codeWord: spec.codeWord,
    wordCount: countWords(bodyMd),
    date: new Date().toISOString().slice(0, 10),
    bodyHtml: md.marked.parse(bodyMd, { async: false }) as string,
  });

  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = (await page.pdf({ format: 'A4', printBackground: true })) as Buffer;
    return pdf;
  } finally {
    await browser.close();
  }
}

async function savePdfLocal(spec: BonusSpec, pdf: Buffer): Promise<{ url: string; localPath: string }> {
  // На VPS лежит /var/www/cdn/, nginx отдаёт https://agent.yury-eremin.ru/cdn/...
  // Для seed-скрипта используем env override (CDN_LOCAL_DIR) или дефолт.
  const dir = process.env.CDN_LOCAL_DIR ?? '/var/www/cdn/bonuses';
  await fs.mkdir(dir, { recursive: true });
  const filename = `${slug(spec.painTag)}-${slug(spec.codeWord)}.pdf`;
  const localPath = path.join(dir, filename);
  await fs.writeFile(localPath, pdf);
  const base = (config.APP_PUBLIC_BASE_URL ?? 'https://agent.yury-eremin.ru').replace(/\/$/, '');
  const url = `${base}/cdn/bonuses/${filename}`;
  return { url, localPath };
}

async function embedLongread(bodyMd: string): Promise<number[]> {
  // OpenAI text-embedding-3-small, лимит ~8191 токенов входа. Для лонгрида 1500-2500 слов
  // это ~3-5К токенов — влезает целиком.
  const trimmed = bodyMd.slice(0, 24000); // safety
  const r = await createEmbedding(trimmed);
  return r.embedding;
}

async function upsertBonus(
  pool: Pool,
  spec: BonusSpec,
  bodyMd: string,
  outline: unknown[],
  pdfUrl: string,
  embedding: number[],
): Promise<string> {
  const vec = `[${embedding.join(',')}]`;
  // pdf_gdrive_id NOT NULL в schema — пишем placeholder. Если позже включим GDrive — обновим UPDATE.
  const pdfGdriveId = `local:${slug(spec.painTag)}`;
  const wordCount = countWords(bodyMd);

  // Идемпотентность: ищем по pain_tag + title + origin='audience_brain'. Если есть — UPDATE.
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM bonus_library
      WHERE pain_tag = $1 AND origin = 'audience_brain' AND deleted_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1`,
    [spec.painTag],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    const id = existing.rows[0]!.id;
    await pool.query(
      `UPDATE bonus_library
          SET title = $2, outline = $3::jsonb, body_md = $4,
              pdf_url = $5, pdf_gdrive_id = $6, word_count = $7,
              embedding = $8::vector, updated_at = NOW()
        WHERE id = $1`,
      [id, spec.title, JSON.stringify(outline), bodyMd, pdfUrl, pdfGdriveId, wordCount, vec],
    );
    log.info({ id, painTag: spec.painTag }, 'seed: bonus UPDATED');
    return id;
  }

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO bonus_library
       (title, pain_tag, outline, body_md, pdf_url, pdf_gdrive_id, word_count,
        embedding, status, origin)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::vector, 'live', 'audience_brain')
     RETURNING id`,
    [
      spec.title,
      spec.painTag,
      JSON.stringify(outline),
      bodyMd,
      pdfUrl,
      pdfGdriveId,
      wordCount,
      vec,
    ],
  );
  const id = ins.rows[0]!.id;
  log.info({ id, painTag: spec.painTag }, 'seed: bonus INSERTED');
  return id;
}

// --- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const bonuses = args.painFilter
    ? SEED_BONUSES.filter((b) => b.painTag === args.painFilter)
    : SEED_BONUSES;
  if (bonuses.length === 0) {
    log.error({ painFilter: args.painFilter }, 'seed: pain_tag не найден');
    process.exit(2);
  }
  log.info(
    { count: bonuses.length, dryRun: args.dryRun, pains: bonuses.map((b) => b.painTag) },
    'seed: starting bonus_library seed',
  );

  const pool = args.dryRun ? null : new Pool({ connectionString: config.DATABASE_URL });

  let okCount = 0;
  let failCount = 0;

  for (const spec of bonuses) {
    try {
      const { bodyMd, outline } = await generateLongread(spec);
      if (countWords(bodyMd) < 1200) {
        throw new Error(`longread too short: ${countWords(bodyMd)} words (< 1200)`);
      }

      const pdf = await renderPdf(spec, bodyMd);
      log.info(
        { painTag: spec.painTag, pdfBytes: pdf.length },
        'seed: PDF rendered',
      );

      if (args.dryRun) {
        log.info(
          { painTag: spec.painTag, wordCount: countWords(bodyMd) },
          'seed: dry-run → skipping CDN upload + DB insert',
        );
        okCount++;
        continue;
      }

      const { url: pdfUrl, localPath } = await savePdfLocal(spec, pdf);
      log.info({ painTag: spec.painTag, pdfUrl, localPath }, 'seed: PDF saved');

      const embedding = await embedLongread(bodyMd);

      const id = await upsertBonus(pool!, spec, bodyMd, outline, pdfUrl, embedding);
      log.info(
        { painTag: spec.painTag, bonusId: id, words: countWords(bodyMd), pdfUrl },
        'seed: ✅ done',
      );
      okCount++;
    } catch (err) {
      failCount++;
      log.error(
        { painTag: spec.painTag, err: (err as Error).message, stack: (err as Error).stack },
        'seed: ❌ failed',
      );
    }
  }

  if (pool) await pool.end();
  log.info({ ok: okCount, failed: failCount, total: bonuses.length }, 'seed: completed');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error({ err: (err as Error).message }, 'seed: fatal');
  process.exit(1);
});
