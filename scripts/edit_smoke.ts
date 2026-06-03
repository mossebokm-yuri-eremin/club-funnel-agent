// EDIT test on 1 reference slide through 3 models.
import { selectCarouselReferences } from '../src/services/carousel-template-selector.js';
import { writeFileSync } from 'node:fs';
import { config } from '../src/config.js';

const PROMPT_RU = `Replace the Russian text on this carousel slide with new Russian text: «Чек растёт от позиционирования, не от наглости». Keep ALL design elements EXACTLY the same: layout, colors, fonts, photos, composition, background, watermark, page number. Only the text content must change.`;

async function callGptunnel(model: string, prompt: string, imageUrls: string[]) {
  const body: Record<string, unknown> = { model, prompt, response_format: 'url' };
  if (imageUrls.length > 0) body.images = imageUrls;
  const startedAt = Date.now();
  const res = await fetch('https://gptunnel.ru/v1/media/generate', {
    method: 'POST',
    headers: { Authorization: config.GPTUNNEL_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - startedAt, body: text };
}

(async () => {
  // 1. Берём 1 эталонный слайд cover из carousel-03-money и копируем в /var/www/cdn/__edit_src/
  const refs = await selectCarouselReferences({
    templateFolderName: 'carousel-03-money',
    voice: 'YE',
    includePortrait: false,
    includePastPost: false,
  });
  if (!refs || refs.refs.length === 0) {
    console.log('no refs');
    process.exit(1);
  }
  const cover = refs.refs.find(r => r.role === 'cover') ?? refs.refs[0]!;
  const srcPath = '/var/www/cdn/__edit_src/cover.jpg';
  writeFileSync(srcPath, Buffer.from(cover.base64, 'base64'));
  const PUB_URL = 'https://agent.yury-eremin.ru/cdn/__edit_src/cover.jpg';
  console.log(`source: ${PUB_URL} (bytes=${cover.bytes})`);

  // 2. Тестируем разные модели
  const models = ['nano-banana', 'nano-banana-2', 'flux-kontext-pro', 'seedream-4', 'gpt-image-1-low'];
  for (const m of models) {
    console.log(`\n=== ${m} ===`);
    const r = await callGptunnel(m, PROMPT_RU, [PUB_URL]);
    console.log(`HTTP ${r.status}  ${r.ms}ms`);
    console.log(`body: ${r.body.slice(0, 600)}`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', (e as Error).message); process.exit(1); });
