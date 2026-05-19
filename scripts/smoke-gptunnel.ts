// Smoke-test для GPTunnel Creative Lab (seedream-4).
// Запуск: cd club-funnel-agent && (set -a; source .env; set +a; npx tsx scripts/smoke-gptunnel.ts)
//
// Печатает: cost, duration, image URL preview. Скачивает картинку в /tmp/smoke-seedream.jpg.

// Заглушки обязательных env-vars (config.ts валидирует Zod — но локально
// нам не нужны Telegram/GC значения для теста GPTunnel).
process.env.YE_TG_USER_ID ||= '0';
process.env.GC_WEBHOOK_SECRET ||= 'smoke';
process.env.TELEGRAM_BOT_TOKEN ||= 'smoke';
process.env.ANTHROPIC_API_KEY ||= 'smoke';

import fs from 'node:fs/promises';
import {
  generateGptunnelImage,
  downloadGptunnelImage,
} from '../src/integrations/gptunnel-creative.js';

async function main(): Promise<void> {
  const prompt =
    'Premium minimalist editorial photography, 9:16 vertical, magazine-quality. ' +
    'A single architectural detail in warm golden light. Soft beige and warm orange tones. ' +
    'Negative space at top for headline overlay. ' +
    'No text, no logos, no people. Style: Kinfolk magazine.';

  console.log('=== GPTunnel seedream-4 smoke ===');
  console.log('prompt (preview):', prompt.slice(0, 100), '...');

  const gen = await generateGptunnelImage({
    prompt,
    aspectRatio: '9:16',
    size: '2K',
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        cost_rub: gen.costRub,
        cost_kopecks: gen.costKopecks,
        duration_ms: gen.durationMs,
        model_used: gen.modelUsed,
        generation_id: gen.generationId,
        image_url_preview: gen.imageUrl.slice(0, 80),
        image_url_length: gen.imageUrl.length,
      },
      null,
      2,
    ),
  );

  // Скачиваем в /tmp — Юрий проверит визуально (open /tmp/smoke-seedream.jpg).
  const buf = await downloadGptunnelImage(gen.imageUrl);
  await fs.writeFile('/tmp/smoke-seedream.jpg', buf);
  console.log(`\n✅ Картинка скачана: /tmp/smoke-seedream.jpg (${buf.length} байт)`);
  console.log('   Открой: open /tmp/smoke-seedream.jpg');
}

main().catch((err) => {
  console.error('FAIL:', (err as Error).message);
  process.exit(1);
});
