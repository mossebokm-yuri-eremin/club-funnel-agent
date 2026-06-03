// e2e-content-gen — реальный pipeline-вызов generateContentPackage с v3 prompts.

import { pool, closePool } from '../src/db/client.js';
import { generateContentPackage } from '../src/services/content-gen.js';
import { randomUUID } from 'node:crypto';

const IDEA = 'Анна Кацапова из Нижневартовска подняла чек с 3500 до 8000 руб/м2 через упаковку и личный бренд';

(async () => {
  const ideaId = randomUUID();
  await pool.query(
    `INSERT INTO ideas (id, source, summary, pain_tag, strategy, status, created_at, updated_at)
     VALUES ($1, 'text', $2, 'pricing-positioning', 'B', 'strategy_chosen', NOW(), NOW())`,
    [ideaId, IDEA],
  );

  console.log(`ideaId=${ideaId}\nCalling generateContentPackage...`);
  const startedAt = Date.now();
  const r = await generateContentPackage(
    {
      ideaId,
      summary: IDEA,
      painTag: 'pricing-positioning',
      strategy: 'B',
      bonusTitle: null,
      codeWord: 'klub_anna_350',
    },
    { pool },
  );
  console.log(`\nTotal duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`pkg id: ${r.contentPackageId}`);
  console.log(`escalated: ${r.escalated}`);
  console.log(`cost USD: ${r.totalCostUsd}`);
  console.log(`attempts: reel=${r.pkg.reelCaption.attempts} tg=${r.pkg.tgPost.attempts} carousel=${r.pkg.carouselSlides.attempts} rz=${r.pkg.rzVariantPost.attempts}`);
  console.log(`reports: reel.ok=${r.pkg.reelCaption.report.ok} tg.ok=${r.pkg.tgPost.report.ok} carousel.ok=${r.pkg.carouselSlides.report.ok} rz.ok=${r.pkg.rzVariantPost.report.ok}`);
  console.log(`\n--- TG POST (YE) ---\n${r.pkg.tgPost.text}\n`);
  console.log(`\n--- RZ POST ---\n${r.pkg.rzVariantPost.text}\n`);
  console.log(`\n--- CAROUSEL (${r.pkg.carouselSlides.slides.length} slides) ---`);
  r.pkg.carouselSlides.slides.forEach((s, i) => console.log(`${i + 1}. ${s}`));

  await closePool();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
