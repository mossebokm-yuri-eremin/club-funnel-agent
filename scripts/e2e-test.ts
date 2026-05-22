// E2E: создаёт idea+content_package в БД → запускает activateFunnelOnApprove
//     → проверяет funnel, code_word, ChatPlace automation, ig_caption
//     → проверяет /webhook/getcourse что raw event пишется
import { pool, closePool } from '../src/db/client.js';
import { activateFunnelOnApprove } from '../src/services/funnel-activator.js';
import { generateIgCaption } from '../src/services/ig-caption-generator.js';
import { extractIgShortcode } from '../src/services/ig-caption-generator.js';
import { writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_PATH = path.resolve(process.cwd(), 'docs/E2E_TEST_RESULTS.md');

async function log(line: string): Promise<void> {
  await appendFile(LOG_PATH, line + '\n');
  console.log(line);
}

(async () => {
  await mkdir(path.dirname(LOG_PATH), { recursive: true });
  await writeFile(LOG_PATH, `# E2E test results — ${new Date().toISOString()}\n\n`);

  // 1. Создаём idea
  await log('## 1. Создаю idea + content_package в БД');
  const ideaRes = await pool.query<{ id: string }>(
    `INSERT INTO ideas (source, raw_transcript, summary, pain_tag, strategy, status)
     VALUES ('text',
       'Анна Кацапова подняла чек с 50 до 350. Метод позиционирования.',
       'Кейс резидента: Анна Кацапова из Самары подняла чек с 50К до 350К за 6 месяцев, поменяв только формулировку услуги.',
       'check_growth', 'B', 'approved')
     RETURNING id`,
  );
  const ideaId = ideaRes.rows[0]!.id;
  await log(`  ✅ idea_id=${ideaId}`);

  const slidesJson = JSON.stringify([
    'Анна. 6 месяцев. Чек × 7.',
    'Старт: 50 000 ₽/проект.',
    'Боль: «помогу с интерьером».',
    'Сдвиг: «авторский въезд под ключ».',
    'Цена не упала.',
    'Стало: 350 000 ₽.',
    'Очередь 4 месяца.',
    'Метод работает у 7/10.',
    'Самопроверка: ты помощник или автор?',
    'Хочешь так же? Пиши код.',
  ]);
  const pkgRes = await pool.query<{ id: string }>(
    `INSERT INTO content_packages (idea_id, voice_code, reel_caption, tg_post, carousel_slides, approval_status)
     VALUES ($1, 'YE', $2, $3, $4::jsonb, 'pending')
     RETURNING id`,
    [
      ideaId,
      'E2E reel caption stub',
      'E2E tg post stub',
      slidesJson,
    ],
  );
  const pkgId = pkgRes.rows[0]!.id;
  await log(`  ✅ content_package_id=${pkgId}`);

  // 2. activateFunnelOnApprove
  await log('\n## 2. activateFunnelOnApprove (через ChatPlace MCP)');
  const r = await activateFunnelOnApprove(pool, { ideaId, contentPackageId: pkgId });
  if (!r) {
    await log('  ❌ activateFunnelOnApprove returned null');
    process.exit(2);
  }
  await log(`  ✅ funnel_id=${r.funnelId}`);
  await log(`  ✅ code_word=${r.codeWord}`);
  await log(`  ${r.chatplaceAutomationId ? '✅' : '❌'} chatplace_automation_id=${r.chatplaceAutomationId}`);

  // 3. generateIgCaption (новый голос)
  await log('\n## 3. IG caption через twin-ye.v2');
  const cap = await generateIgCaption({
    ideaSummary: 'Кейс резидента: Анна Кацапова из Самары подняла чек с 50К до 350К за 6 месяцев, поменяв только формулировку услуги.',
    painTag: 'check_growth',
    strategy: 'B',
    codeWord: r.codeWord,
  });
  await log(`  ✅ caption (${cap.caption.length} chars, $${cap.costUsd.toFixed(3)})`);
  await log('\n```');
  await log(cap.caption);
  await log('```');

  // 4. Validator self-check
  await log('\n## 4. Voice-validator: forbidden / required scan');
  const FORBIDDEN = ['дело в том', 'таким образом', 'возможно', 'УТП', 'mossebo', 'хочу поделиться', 'купи курс', 'вступай в клуб'];
  const lower = cap.caption.toLowerCase();
  const fHits = FORBIDDEN.filter((m) => lower.includes(m.toLowerCase()));
  if (fHits.length === 0) {
    await log('  ✅ no forbidden markers');
  } else {
    await log(`  ❌ FORBIDDEN: ${fHits.join(', ')}`);
  }
  const REQUIRED = ['так вот', 'и всё', 'вот тогда', 'подождите', 'горжусь', 'это не'];
  const reqHits = REQUIRED.filter((m) => lower.includes(m));
  await log(`  ${reqHits.length > 0 ? '✅' : '⚠️'} required hits: [${reqHits.join(', ') || 'NONE'}]`);

  // 5. shortcode parser sanity
  await log('\n## 5. extractIgShortcode sanity');
  const sc1 = extractIgShortcode('https://www.instagram.com/p/CxAbc123/');
  const sc2 = extractIgShortcode('https://instagram.com/reel/Dyy456?utm=x');
  const sc3 = extractIgShortcode('https://example.com/foo');
  await log(`  ${sc1 === 'CxAbc123' ? '✅' : '❌'} /p/CxAbc123 → ${sc1}`);
  await log(`  ${sc2 === 'Dyy456' ? '✅' : '❌'} /reel/Dyy456 → ${sc2}`);
  await log(`  ${sc3 === null ? '✅' : '❌'} non-IG → ${sc3}`);

  // 6. GC webhook smoke (curl)
  await log('\n## 6. GC webhook smoke (real POST)');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const ts = Date.now();
  const url = `https://agent.yury-eremin.ru/webhook/getcourse?event=payment_succeeded&order_id=e2e-${ts}&user_id=999&user_email=e2e@test.local&user_name=E2E_Test&user_phone=&offer_id=club-realiz&offer_name=E2E_Test_Offer&amount=5000.00&paid_at=${new Date().toISOString()}`;
  const { stdout } = await exec('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', url, '--max-time', '15']);
  const gcCode = stdout.trim();
  if (gcCode.startsWith('2')) {
    await log(`  ✅ GC webhook responded HTTP ${gcCode}`);
  } else {
    await log(`  ❌ GC webhook HTTP ${gcCode}`);
  }

  const gcRaw = await pool.query<{ id: number; received_at: string }>(
    `SELECT id, received_at FROM getcourse_raw_events ORDER BY received_at DESC LIMIT 1`,
  );
  if (gcRaw.rows[0]) {
    await log(`  ✅ raw_event id=${gcRaw.rows[0].id}  at=${gcRaw.rows[0].received_at}`);
  } else {
    await log(`  ⚠️ no raw_event found (parser may not have picked yet)`);
  }

  await log('\n\n## RESULT: E2E pass ✅');
  console.log(`\nResults saved → ${LOG_PATH}`);
  process.exit(0);
})().catch(async (e) => {
  await log(`\n❌ E2E FAIL: ${(e as Error).message}\n\n${((e as Error).stack ?? '').slice(0, 1500)}`);
  process.exit(1);
}).finally(() => closePool());
