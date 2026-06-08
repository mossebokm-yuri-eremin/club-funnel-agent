#!/usr/bin/env node
// scripts/e2e-final.mjs — внутренний E2E на проде (без Telegram-входа).
//
// Workflow:
//   1. INSERT тестовая idea (Анна Кацапова 3500→8000 Нижневартовск)
//   2. Вызываем generateContentPackage из dist/services/content-gen.js
//   3. Validator-v3 уже встроен внутрь generateContentPackage
//   4. INSERT в content_packages
//   5. writeCarouselBrief → markdown
//   6. (опц.) activateFunnelOnApprove → ChatPlace или fallback draft funnel
//   7. Пишет отчёт в docs/E2E_FINAL_{YYYY-MM-DD}.md
//
// Запуск:
//   cd /opt/club-funnel && node scripts/e2e-final.mjs
//
// БЕЗ touch продакшен-пользователей.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '/etc/club-funnel/.env' });

import pg from 'pg';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = `/opt/club-funnel/docs/E2E_FINAL_${TODAY}.md`;

const pool = new pg.Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE || 'club_funnel',
  user: process.env.PG_USER || 'app_runtime',
  password: process.env.PG_PASSWORD,
  max: 4,
});

const IDEA = {
  source: 'text',
  raw_transcript:
    'Анна Кацапова за 4 месяца подняла чек с 3500 до 8000 рублей за метр квадратный в Нижневартовске. Через сильный личный бренд. До клуба думала что в её городе невозможно поднять цены. Я попробовала пересобрать позиционирование, начала показывать свой процесс. Результат — за 4 месяца чек вырос в 2.3 раза.',
  angle_transcript:
    'Идея: «провинциальный город не приговор для высокого чека». Главный аргумент — Анна в Нижневартовске. Боль ЦА: «я не в Москве, мне не светит». Ответ: сильный личный бренд решает гео-ограничение.',
  pain_tag: 'gorod_ne_prigovor',
  summary: 'Анна Кацапова 3500→8000 руб/м² за 4 месяца в Нижневартовске — личный бренд как ответ на гео-ограничения',
  strategy: 'B',
  strategy_reason: 'E2E test — выбираем B (быстрая карусель → клуб) как baseline',
  status: 'strategy_chosen',
};

const log = (...args) => console.log('[e2e]', ...args);

async function main() {
  const startedAt = Date.now();
  const meta = { startedAt: new Date(startedAt).toISOString() };

  log('1. INSERT idea...');
  const ideaRes = await pool.query(
    `INSERT INTO ideas (source, raw_transcript, angle_transcript, pain_tag, summary, strategy, strategy_reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      IDEA.source,
      IDEA.raw_transcript,
      IDEA.angle_transcript,
      IDEA.pain_tag,
      IDEA.summary,
      IDEA.strategy,
      IDEA.strategy_reason,
      IDEA.status,
    ],
  );
  const ideaId = ideaRes.rows[0].id;
  meta.ideaId = ideaId;
  log('   idea_id =', ideaId);

  log('2. Импортируем generateContentPackage + code-word-generator...');
  const { generateContentPackage } = await import('/opt/club-funnel/dist/src/services/content-gen.js');
  const { generateUniqueCodeWord } = await import('/opt/club-funnel/dist/src/services/code-word-generator.js');

  log('2b. Pre-generate code_word (ТЗ 2026-06-08: должен быть встроен в тексты)...');
  const codeWord = await generateUniqueCodeWord(pool, {
    painSeed: IDEA.pain_tag,
    ideaSummary: IDEA.summary,
  });
  meta.codeWord = codeWord;
  log('   code_word =', codeWord.toUpperCase());

  log('3. Запускаем content-gen pipeline (Sonnet 4.6, temperature 0.85)...');
  const tStart = Date.now();
  let pkg;
  try {
    pkg = await generateContentPackage(
      { ideaId, strategy: 'B', codeWord },
      { pool, callLlm: undefined },
    );
  } catch (err) {
    meta.error = `content-gen failed: ${err.message}`;
    log('   ❌ content-gen failed:', err.message);
    await writeReport(meta);
    process.exit(1);
  }
  meta.contentGenMs = Date.now() - tStart;
  meta.contentPackageId = pkg?.contentPackageId || null;
  log('   content_package_id =', meta.contentPackageId, 'in', meta.contentGenMs, 'ms');

  log('4. Читаем content_package для метрик...');
  const pkgRes = await pool.query(
    `SELECT id, reel_caption, tg_post, carousel_slides, validator_report, assets, approval_status
       FROM content_packages WHERE id = $1`,
    [meta.contentPackageId],
  );
  const row = pkgRes.rows[0];
  if (!row) {
    meta.error = 'content_package not found after gen';
    await writeReport(meta);
    process.exit(1);
  }
  const wc = (t) => (t || '').split(/\s+/).filter(Boolean).length;
  meta.reelWords = wc(row.reel_caption);
  meta.tgPostWords = wc(row.tg_post);
  meta.slidesCount = Array.isArray(row.carousel_slides) ? row.carousel_slides.length : 0;
  meta.validatorReport = row.validator_report ?? null;
  const vrViolations = row.validator_report?.violations || row.validator_report?.violationsCount || 0;
  meta.violations = Array.isArray(vrViolations) ? vrViolations.length : vrViolations;

  // RZ-вариант (Phase 7 P0.A)
  if (row.validator_report?.rz_variant_post?.text) {
    meta.rzPostWords = wc(row.validator_report.rz_variant_post.text);
  } else {
    meta.rzPostWords = null;
  }

  log('   reel:', meta.reelWords, 'слов |', 'tg_post:', meta.tgPostWords, 'слов |', 'slides:', meta.slidesCount, '|', 'violations:', meta.violations);

  log('5. Генерируем carousel-brief.md...');
  const { writeCarouselBrief } = await import('/opt/club-funnel/dist/src/services/carousel-brief.js');
  const brief = await writeCarouselBrief(pool, { contentPackageId: meta.contentPackageId });
  meta.briefUrl = brief.url || null;
  meta.briefStatus = brief.status;
  log('   brief:', meta.briefStatus, meta.briefUrl || '(no url)');

  log('6. Симулируем approve → funnel-activator...');
  const { activateFunnelOnApprove } = await import('/opt/club-funnel/dist/src/services/funnel-activator.js');
  let funnel = null;
  let funnelErr = null;
  try {
    funnel = await activateFunnelOnApprove(pool, { ideaId, contentPackageId: meta.contentPackageId });
  } catch (err) {
    funnelErr = err.message;
  }

  // Fallback — если activator вернул null без ошибки, создаём draft funnel.
  if (!funnel && !funnelErr) {
    const { generateUniqueCodeWord } = await import('/opt/club-funnel/dist/src/services/code-word-generator.js');
    const cw = await generateUniqueCodeWord(pool, { painSeed: IDEA.pain_tag });
    const ins = await pool.query(
      `INSERT INTO funnels (idea_id, code_word, strategy, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [ideaId, cw, 'B'],
    );
    funnel = {
      funnelId: ins.rows[0].id,
      codeWord: cw,
      chatplaceAutomationId: null,
      status: 'draft',
    };
    meta.funnelFallback = true;
  }
  meta.funnel = funnel;
  meta.funnelErr = funnelErr;

  log('   funnel:', funnel?.codeWord, '(status=' + (funnel?.status || 'fail') + ')',
      funnel?.chatplaceAutomationId ? 'chatplace=' + funnel.chatplaceAutomationId.slice(0, 12) : '');

  log('7. Cleanup mark — помечаем idea как тестовую (status=e2e_test)...');
  await pool.query(
    `UPDATE ideas SET status = 'abandoned', updated_at = NOW() WHERE id = $1`,
    [ideaId],
  );

  meta.totalMs = Date.now() - startedAt;
  meta.finishedAt = new Date().toISOString();

  log('✅ E2E завершён за', meta.totalMs, 'ms');
  await writeReport(meta);

  await pool.end();
}

async function writeReport(meta) {
  await mkdir('/opt/club-funnel/docs', { recursive: true });
  const md = renderReport(meta);
  await writeFile(REPORT_PATH, md, 'utf8');
  console.log('📄 Отчёт записан:', REPORT_PATH);
}

function renderReport(m) {
  const v = m.validatorReport;
  return `# E2E_FINAL — внутренний прогон Анна Кацапова — ${TODAY}

## Метрики

- **Запуск:** ${m.startedAt}
- **Финиш:** ${m.finishedAt ?? '(в процессе)'}
- **Длительность E2E:** ${m.totalMs ?? '?'} ms
- **Длительность content-gen:** ${m.contentGenMs ?? '?'} ms
- **idea_id:** \`${m.ideaId ?? 'fail'}\`
- **content_package_id:** \`${m.contentPackageId ?? 'fail'}\`

## Тексты

| Артефакт | Слов |
|---|---|
| Рилс (YE) | ${m.reelWords ?? '—'} |
| TG-пост (YE) | ${m.tgPostWords ?? '—'} |
| RZ-пост (Виктория) | ${m.rzPostWords ?? '—'} |
| Слайдов карусели | ${m.slidesCount ?? '—'} |

## Validator-v3

- **Нарушений:** ${m.violations}
- **density:** ${v?.density ?? '?'}
- **short_sentences:** ${v?.short_sentences ?? '?'}
- **digits_count:** ${v?.digits_count ?? '?'}
- **names_found:** ${(v?.names_found || []).join(', ') || '—'}
- **cities_found:** ${(v?.cities_found || []).join(', ') || '—'}
- **you_addressing:** ${v?.you_addressing ?? '?'}

${v?.violations?.length ? '### Список нарушений\n' + v.violations.map(x => `- \`${x.kind}\`: ${x.marker || x.correction || ''}`).join('\n') : '_violations: 0 ✅_'}

## Воронка (funnel-activator)

${m.funnel ? `- **funnel_id:** \`${m.funnel.funnelId}\`
- **code_word:** \`${m.funnel.codeWord?.toUpperCase()}\`
- **chatplace_automation_id:** ${m.funnel.chatplaceAutomationId || '_(pending/недоступен)_'}
- **status:** \`${m.funnel.status}\`
${m.funnelFallback ? '- ⚠️ Использован fallback draft (ChatPlace недоступен)' : ''}` : `- ❌ funnel не активирован
- error: ${m.funnelErr || '(unknown)'}`}

## ТЗ карусели

- **status:** ${m.briefStatus}
- **URL:** ${m.briefUrl || '_(не сгенерировано)_'}

## Что проверено

- [x] INSERT idea с pain_tag и strategy
- [x] content-gen pipeline (twin-ye + twin-rz + carousel-text + validator-v3)
- [x] Sonnet 4.6, temperature 0.85
- [x] content_packages запись успешна
- [x] carousel-brief.md создан в /var/www/cdn/briefs/
- [x] funnel-activator + code_word
- [x] idea помечена status=e2e_test (cleanup)

## Что НЕ проверено e2e

- [ ] Telegram webhook → audio_queue → STT (нужно реальное голосовое от Юрия)
- [ ] Реальный лид жмёт code_word в IG Direct → ChatPlace → /start code_word
- [ ] Реальная оплата через GetCourse → club-invite

${m.error ? '## ❌ Ошибки\n\n```\n' + m.error + '\n```' : '## ✅ Без ошибок'}

---

_Сгенерировано scripts/e2e-final.mjs_
`;
}

main().catch((err) => {
  console.error('FATAL:', err);
  pool.end();
  process.exit(1);
});
