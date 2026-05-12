// PDF render — SPEC §2.6 AC-18.
//
// Принимает markdown + метаданные → HTML через Handlebars → PDF через Puppeteer
// (headless Chromium) → upload в Google Drive → запись в bonus_library со
// status='live'. Только после успешной загрузки в GDrive строка считается «live»
// (см. CLAUDE.md «Никаких УТП» и AC-18: «pdf_url, pdf_gdrive_id обязательны»).
//
// Зависимости держим инжектируемыми:
//   - htmlToPdf(): фактический PDF-рендер. По умолчанию — `puppeteer` через
//     dynamic import; тесты подсовывают функцию-заглушку, чтобы не тянуть Chromium.
//   - mdToHtml(): markdown → html. По умолчанию — простой регэксп-конвертер,
//     достаточный для лонгридов (h1/h2/h3, абзацы, цитаты, ul, bold/italic).
//     Полноценный markdown-it подключим, когда упрётся об ограничения.
//   - uploader: GDriveUploader (см. integrations/gdrive.ts).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import type { Pool } from 'pg';
import { log } from '../observability/logger.js';
import { createGDriveUploader, type GDriveUploader } from '../integrations/gdrive.js';

export interface PdfRenderInput {
  ideaId: string;
  title: string;
  painTag: string;
  codeWord: string;
  /** Markdown body, прошедший voice validator (longread-factory). */
  bodyMd: string;
  /** Optional outline для записи в bonus_library.outline (JSONB). */
  outline?: Array<{ h2: string; summary: string }>;
}

export interface PdfRenderResult {
  bonusId: string;
  pdfUrl: string;
  pdfGdriveId: string;
  wordCount: number;
}

export type HtmlToPdf = (html: string) => Promise<Buffer>;

export interface PdfRenderDeps {
  pool: Pool;
  htmlToPdf?: HtmlToPdf;
  mdToHtml?: (md: string) => string;
  uploader?: GDriveUploader;
  templatePath?: string;
}

const _templateCache = new Map<string, HandlebarsTemplateDelegate>();
async function getTemplate(templatePath?: string): Promise<HandlebarsTemplateDelegate> {
  const defaultPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'templates',
    'longread.hbs',
  );
  const resolvedPath = templatePath ?? defaultPath;
  const cached = _templateCache.get(resolvedPath);
  if (cached) return cached;
  const raw = await readFile(resolvedPath, 'utf8');
  const compiled = Handlebars.compile(raw, { noEscape: false });
  _templateCache.set(resolvedPath, compiled);
  return compiled;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Минимальный MD → HTML. Покрывает: h1/h2/h3, > цитаты, *bold*, _italic_,
// списки `- `, пустые строки → <p>. Этого хватает для лонгридов; для сложного
// MD подключим markdown-it в отдельной задаче.
function defaultMdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inList = false;
  let inPara: string[] = [];
  let inQuote: string[] = [];

  const flushPara = (): void => {
    if (inPara.length > 0) {
      out.push(`<p>${inline(inPara.join(' '))}</p>`);
      inPara = [];
    }
  };
  const flushQuote = (): void => {
    if (inQuote.length > 0) {
      out.push(`<blockquote>${inline(inQuote.join(' '))}</blockquote>`);
      inQuote = [];
    }
  };
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  const inline = (s: string): string => {
    let t = escapeHtml(s);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1<em>$2</em>');
    t = t.replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>');
    return t;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flushPara();
      flushQuote();
      closeList();
      continue;
    }
    const h1 = line.match(/^# (.+)$/);
    if (h1) {
      flushPara();
      flushQuote();
      closeList();
      out.push(`<h1>${inline(h1[1]!)}</h1>`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2) {
      flushPara();
      flushQuote();
      closeList();
      out.push(`<h2>${inline(h2[1]!)}</h2>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3) {
      flushPara();
      flushQuote();
      closeList();
      out.push(`<h3>${inline(h3[1]!)}</h3>`);
      continue;
    }
    if (line.startsWith('> ')) {
      flushPara();
      closeList();
      inQuote.push(line.slice(2));
      continue;
    }
    if (line.startsWith('- ')) {
      flushPara();
      flushQuote();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    closeList();
    flushQuote();
    inPara.push(line);
  }
  flushPara();
  flushQuote();
  closeList();
  return out.join('\n');
}

function countWords(text: string): number {
  const m = text.trim().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

async function lazyPuppeteerPdf(html: string): Promise<Buffer> {
  // Динамический импорт, чтобы тесты не падали на отсутствующем `puppeteer`.
  // Прод-окружение должно иметь установленный `puppeteer` + Chromium.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let puppeteer: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    puppeteer = (await import('puppeteer' as any)) as any;
  } catch (err) {
    throw new Error(
      `pdf-render: puppeteer not installed. Install it (\`pnpm add puppeteer\`) or inject htmlToPdf. ` +
        `Original: ${(err as Error).message}`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const launch = (puppeteer.default ?? puppeteer).launch as (opts: unknown) => Promise<any>;
  const browser = await launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = (await page.pdf({ format: 'A4', printBackground: true })) as Buffer;
    return pdf;
  } finally {
    await browser.close();
  }
}

export async function renderLongreadPdf(
  input: PdfRenderInput,
  deps: PdfRenderDeps,
): Promise<PdfRenderResult> {
  const template = await getTemplate(deps.templatePath);
  const htmlBody = (deps.mdToHtml ?? defaultMdToHtml)(input.bodyMd);
  const wordCount = countWords(input.bodyMd);
  const html = template({
    title: input.title,
    painTag: input.painTag,
    codeWord: input.codeWord,
    wordCount,
    date: new Date().toISOString().slice(0, 10),
    bodyHtml: htmlBody,
  });

  const htmlToPdf = deps.htmlToPdf ?? lazyPuppeteerPdf;
  const pdfBytes = await htmlToPdf(html);
  const uploader = deps.uploader ?? createGDriveUploader();
  const filename = `${input.codeWord || 'longread'}-${input.ideaId.slice(0, 8)}.pdf`;
  const uploaded = await uploader.uploadPdf({ filename, bytes: pdfBytes });

  const outlineJson = JSON.stringify(input.outline ?? []);
  const result = await deps.pool.query<{ id: string }>(
    `INSERT INTO bonus_library
       (title, pain_tag, outline, body_md, pdf_url, pdf_gdrive_id, word_count,
        status, origin, source_idea_id)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, 'live', 'strategy_c', $8)
     RETURNING id`,
    [
      input.title,
      input.painTag,
      outlineJson,
      input.bodyMd,
      uploaded.webViewLink,
      uploaded.fileId,
      wordCount,
      input.ideaId,
    ],
  );
  const bonusId = result.rows[0]?.id;
  if (!bonusId) throw new Error('pdf-render: bonus_library insert returned no id');

  await deps.pool.query(`UPDATE ideas SET bonus_id = $2 WHERE id = $1`, [input.ideaId, bonusId]);

  log.info(
    { ideaId: input.ideaId, bonusId, pdfGdriveId: uploaded.fileId, wordCount },
    'pdf-render: longread saved to bonus_library',
  );

  return {
    bonusId,
    pdfUrl: uploaded.webViewLink,
    pdfGdriveId: uploaded.fileId,
    wordCount,
  };
}

// Экспортируем internals для юнит-тестирования.
export const __internals = { defaultMdToHtml, countWords };
