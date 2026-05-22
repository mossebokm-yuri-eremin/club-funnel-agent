// preview-template — рендерит HTML-шаблон в 10 PNG-слайдов через Puppeteer.
// Запуск: tsx scripts/preview-template.ts <template-name> <data-json>
// Пример: tsx scripts/preview-template.ts yury-universal-v1 /tmp/preview-data.json

import puppeteer from 'puppeteer';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const TEMPLATE_DIR = path.resolve(process.cwd(), 'src/templates/carousel-html');
const OUTPUT_BASE = '/var/www/cdn/preview';
const PUBLIC_BASE = 'https://agent.yury-eremin.ru/cdn/preview';

interface SlideData {
  [key: string]: string;
}

/** Простая mustache-замена {{key}} → value. */
function applyTemplate(html: string, data: SlideData): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = data[key];
    return typeof v === 'string' ? v : `{{${key}}}`; // оставляем плейсхолдер если нет
  });
}

async function renderCarousel(templateName: string, data: SlideData): Promise<string[]> {
  const tplPath = path.join(TEMPLATE_DIR, `${templateName}.html`);
  const tpl = await readFile(tplPath, 'utf8');
  const html = applyTemplate(tpl, data);

  const outDir = path.join(OUTPUT_BASE, templateName);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // write resolved html for debugging (доступен по URL чтобы тоже посмотреть)
  await writeFile(path.join(outDir, 'rendered.html'), html);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30_000 });
  // Wait for fonts to load
  await page.evaluate(() => (document as Document).fonts?.ready);

  const urls: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const sel = `#slide-${i}`;
    const el = await page.$(sel);
    if (!el) {
      console.log(`MISSING slide ${i}, skip`);
      continue;
    }
    const png = await el.screenshot({ omitBackground: false, type: 'png' });
    const fname = `slide-${String(i).padStart(2, '0')}.png`;
    await writeFile(path.join(outDir, fname), png as Buffer);
    urls.push(`${PUBLIC_BASE}/${templateName}/${fname}`);
    console.log(`  rendered ${fname}  (${(png as Buffer).length} bytes)`);
  }

  await browser.close();
  return urls;
}

async function main(): Promise<void> {
  const [, , templateName, dataPath] = process.argv;
  if (!templateName || !dataPath) {
    console.error('usage: tsx preview-template.ts <template-name> <data.json>');
    process.exit(1);
  }
  const dataJson = await readFile(dataPath, 'utf8');
  const data = JSON.parse(dataJson) as SlideData;
  console.log(`=== rendering template ${templateName} ===`);
  const urls = await renderCarousel(templateName, data);
  console.log(`\n=== ${urls.length} slides rendered ===`);
  for (const u of urls) console.log(`  ${u}`);
}

main().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); });
