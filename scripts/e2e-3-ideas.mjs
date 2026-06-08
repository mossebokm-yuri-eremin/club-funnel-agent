#!/usr/bin/env node
// 3 идеи последовательно — для финального аудита промптов.
// Источник: ТЗ Юрия 2026-06-08.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/etc/club-funnel/.env' });
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'club_funnel',
  user: process.env.PG_USER || 'app_runtime',
  password: process.env.PG_PASSWORD,
  max: 4,
});

const IDEAS = [
  {
    name: 'Анна Кацапова Нижневартовск',
    summary: 'Анна Кацапова 3500→8000 руб/м² за 4 месяца в Нижневартовске — личный бренд как ответ на гео-ограничения',
    pain_tag: 'gorod_ne_prigovor',
    raw: 'Анна Кацапова за 4 месяца подняла чек с 3500 до 8000 рублей за метр квадратный в Нижневартовске. Через сильный личный бренд.',
    angle: 'Провинциальный город не приговор для высокого чека. Сильный личный бренд решает гео-ограничение.',
  },
  {
    name: 'Синдром самозванца',
    summary: 'Синдром самозванца у дизайнеров — нет внешнего разрешения поднять чек',
    pain_tag: 'sindrom_samozvantsa',
    raw: 'Дизайнеры годами ждут чьего-то разрешения поднять чек. Им кажется что нужна корочка, диплом, признание. Только в бизнесе нет учителя, есть рынок.',
    angle: 'Эксперт — это решение, а не звание. Никто не выдаст разрешение, бери и делай.',
  },
  {
    name: 'Авторский надзор',
    summary: 'Авторский надзор — это позиция, а не услуга',
    pain_tag: 'avtorsky_nadzor',
    raw: 'Авторский надзор большинство продают как дополнительную услугу за процент. Но это не услуга, это позиция дизайнера в проекте.',
    angle: 'Если продаёшь надзор как услугу — теряешь авторитет. Если занимаешь позицию — клиент платит больше за весь проект.',
  },
];

const log = (...args) => console.log('[3ideas]', ...args);

async function runOne(idea) {
  log(`\n=== Идея: ${idea.name} ===`);

  const ideaRes = await pool.query(
    `INSERT INTO ideas (source, raw_transcript, angle_transcript, pain_tag, summary, strategy, strategy_reason, status)
     VALUES ('text', $1, $2, $3, $4, 'B', '3-ideas test', 'strategy_chosen')
     RETURNING id`,
    [idea.raw, idea.angle, idea.pain_tag, idea.summary],
  );
  const ideaId = ideaRes.rows[0].id;
  log(`  idea_id: ${ideaId}`);

  const { generateContentPackage } = await import('/opt/club-funnel/dist/src/services/content-gen.js');
  const t0 = Date.now();
  const pkg = await generateContentPackage({ ideaId, strategy: 'B' }, { pool });
  const dur = Date.now() - t0;
  log(`  content_package_id: ${pkg.contentPackageId} (${dur} ms)`);

  const pkgRes = await pool.query(
    `SELECT reel_caption, tg_post, carousel_slides, validator_report FROM content_packages WHERE id=$1`,
    [pkg.contentPackageId],
  );
  const row = pkgRes.rows[0];
  const wc = (t) => (t || '').split(/\s+/).filter(Boolean).length;

  // funnel-activator + ig-caption
  const { activateFunnelOnApprove } = await import('/opt/club-funnel/dist/src/services/funnel-activator.js');
  const funnel = await activateFunnelOnApprove(pool, { ideaId, contentPackageId: pkg.contentPackageId });
  log(`  code_word: ${funnel?.codeWord?.toUpperCase()} (chatplace=${funnel?.chatplaceAutomationId?.slice(0, 12) ?? 'null'})`);

  const { generateIgCaption } = await import('/opt/club-funnel/dist/src/services/ig-caption-generator.js');
  const ig = await generateIgCaption({
    pool,
    ideaSummary: idea.summary,
    painTag: idea.pain_tag,
    strategy: 'B',
    codeWord: funnel.codeWord,
  });
  log(`  ig_caption: ${ig.caption.length} chars, ${wc(ig.caption)} слов`);

  // Сохраним для brief.md
  await pool.query(
    `UPDATE content_packages SET assets = COALESCE(assets,'{}'::jsonb) || jsonb_build_object('ig_caption', $1::text, 'ig_code_word', $2) WHERE id=$3`,
    [ig.caption, funnel.codeWord, pkg.contentPackageId],
  );

  const { writeCarouselBrief } = await import('/opt/club-funnel/dist/src/services/carousel-brief.js');
  await writeCarouselBrief(pool, { contentPackageId: pkg.contentPackageId });

  // Cleanup
  await pool.query(`UPDATE ideas SET status='abandoned', updated_at=NOW() WHERE id=$1`, [ideaId]);

  const slides = Array.isArray(row.carousel_slides) ? row.carousel_slides.length : 0;
  return {
    idea: idea.name,
    ideaId,
    pkgId: pkg.contentPackageId,
    codeWord: funnel.codeWord.toUpperCase(),
    chatplace: funnel.chatplaceAutomationId,
    reelWords: wc(row.reel_caption),
    reelText: row.reel_caption,
    tgWords: wc(row.tg_post),
    tgText: row.tg_post,
    rzText: row.validator_report?.rz_variant_post?.text ?? null,
    rzWords: row.validator_report?.rz_variant_post?.text ? wc(row.validator_report.rz_variant_post.text) : 0,
    slides,
    slidesTexts: row.carousel_slides,
    igCaption: ig.caption,
    igWords: wc(ig.caption),
    briefUrl: `https://agent.yury-eremin.ru/cdn/briefs/${pkg.contentPackageId}.md`,
    durationMs: dur,
  };
}

async function main() {
  const results = [];
  for (const idea of IDEAS) {
    try {
      results.push(await runOne(idea));
    } catch (err) {
      console.error(`ERR на ${idea.name}:`, err.message);
      results.push({ idea: idea.name, error: err.message });
    }
  }
  console.log('\n\n========= ИТОГИ 3 ИДЕИ =========');
  for (const r of results) {
    console.log(`\n--- ${r.idea} ---`);
    if (r.error) { console.log('ERR:', r.error); continue; }
    console.log(`pkg_id: ${r.pkgId}`);
    console.log(`code_word: ${r.codeWord}`);
    console.log(`ChatPlace: ${r.chatplace?.slice(0, 12)}`);
    console.log(`reel: ${r.reelWords} слов | tg_post: ${r.tgWords} | rz: ${r.rzWords} | slides: ${r.slides} | ig_caption: ${r.igWords} слов`);
    console.log(`brief.md: ${r.briefUrl}`);
  }

  // Сохраним полный JSON для отчёта
  const fs = await import('node:fs/promises');
  await fs.writeFile('/tmp/3ideas-results.json', JSON.stringify(results, null, 2), 'utf8');
  console.log('\n✓ Сохранён /tmp/3ideas-results.json');

  await pool.end();
}

main().catch((err) => { console.error('FATAL:', err); pool.end(); process.exit(1); });
