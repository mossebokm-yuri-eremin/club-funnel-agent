// test-carousel-faces — рендерит тестовую карусель Юрия на идее про офис
// с принудительным шаблоном main-2026-05 (содержит 20 портретов man-40-50).
//
// Цель: визуально проверить замену лица Юрия nano-banana-2 на портретных слайдах.
// Использует НЕ оригинальный content_package (там старый текст «дорогой чек»),
// а вставляет новые слайды с правильной терминологией («высокий чек», «платёжеспособный»).

import { renderCarousel } from '../src/services/carousel-renderer.js';
import { pool, closePool } from '../src/db/client.js';
import { randomUUID } from 'node:crypto';

const NEW_SLIDES = [
  'Высокий чек — это не офис в центре.',
  'Не команда из 10 человек. Не брендированные папки.',
  'Это позиционирование. И живёт оно в голове, а не в интерьере приёмной.',
  'Анна из Самары с одним помощником закрыла год на 8 млн.',
  'Дмитрий из Москвы со студией в восемь — на 5 млн с минусом по аренде.',
  'Платёжеспособный клиент платит за смыслы. Не за квадратные метры.',
  'Так вот. Я проверял.',
];

const FORCE_TEMPLATE = process.env.FORCE_TEMPLATE ?? 'main-2026-05';

(async () => {
  // 1. Создаём временную идею и content_package в БД.
  const ideaId = randomUUID();
  await pool.query(
    `INSERT INTO ideas (id, source, summary, pain_tag, created_at, updated_at)
     VALUES ($1, 'text', $2, $3, NOW(), NOW())`,
    [
      ideaId,
      'Высокий чек делается позиционированием и смыслами, а не офисом и раздутой командой.',
      'pricing-positioning',
    ],
  );

  const pkgId = randomUUID();
  await pool.query(
    `INSERT INTO content_packages
       (id, idea_id, voice_code, tg_post, reel_caption,
        carousel_slides, created_at, updated_at)
     VALUES ($1, $2, 'YE', 'тест', 'тест', $3::jsonb, NOW(), NOW())`,
    [pkgId, ideaId, JSON.stringify(NEW_SLIDES)],
  );

  console.log(`Created ideaId=${ideaId}`);
  console.log(`Created pkgId=${pkgId}`);
  console.log(`Forcing template: ${FORCE_TEMPLATE}\n`);

  // 2. Force template через env (CAROUSEL_FORCE_TEMPLATE).
  process.env.CAROUSEL_FORCE_TEMPLATE = FORCE_TEMPLATE;
  // Reset config cache (config loads env at startup; ensure we pass through).
  // В наших настройках config.CAROUSEL_FORCE_TEMPLATE читается один раз при импорте,
  // поэтому ensure that the worker is restarted before this script runs — see deploy.

  // 3. Рендерим.
  const result = await renderCarousel({ contentPackageId: pkgId }, { pool });

  console.log('\n=== RESULT ===');
  console.log(`mode=${result.mode} theme=${result.theme} template=${result.templateFolderName}`);
  console.log(`slides rendered: ${result.slides.length}, total ms: ${result.totalDurationMs}\n`);
  for (const s of result.slides) {
    console.log(`  slide ${s.index}: ${s.url}  (${s.bytes} bytes, ${s.durationMs}ms)`);
  }

  // 4. Cleanup test rows.
  await pool.query(`DELETE FROM content_packages WHERE id = $1`, [pkgId]);
  await pool.query(`DELETE FROM ideas WHERE id = $1`, [ideaId]);
  console.log('\nTemp rows cleaned up.');

  await closePool();
  process.exit(0);
})();
