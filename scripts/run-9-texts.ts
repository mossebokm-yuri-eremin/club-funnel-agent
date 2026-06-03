// run-9-texts — финальный прогон 3 идеи × 3 формата (YE-пост + RZ-пост + 10-сл. карусель).
//
// Модель: claude-sonnet-4-6 (последний доступный generative).
// Промпты: src/prompts/twin-ye.ts, twin-rz.ts, carousel-text.ts (новые v3).
// Validation: voice-validator-v3 (динамически из knowledge/voice-analysis-ye-v3.md).
// Retry: 3 попытки на пост; при провале — лог в БД failed_generations (если есть) или stdout.

import Anthropic from '@anthropic-ai/sdk';
import { pool, closePool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { buildTwinYePrompt } from '../src/prompts/twin-ye.js';
import { buildTwinRzPrompt } from '../src/prompts/twin-rz.js';
import { buildCarouselTextPrompt } from '../src/prompts/carousel-text.js';
import { validateVoiceV3, validateFacts } from '../src/services/voice-validator-v3.js';

const MODEL = config.ANTHROPIC_MODEL_GENERATIVE ?? 'claude-sonnet-4-6';
const MAX_RETRIES = 3;

const IDEAS = [
  'Анна Кацапова из Нижневартовска подняла чек с 3500 до 8000 руб/м2 через упаковку и личный бренд',
  'Почему дизайнеры теряют клиента после первого проекта',
  'Авторский надзор — это не услуга, это позиция дизайнера',
];

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

async function callClaude(system: string, userText: string, maxTokens = 2000): Promise<string> {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.8,
    system,
    messages: [{ role: 'user', content: userText }],
  });
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}

async function generateYePost(ideaText: string): Promise<{ text: string; report: Awaited<ReturnType<typeof validateVoiceV3>>; attempts: number }> {
  const { systemPrompt } = await buildTwinYePrompt(pool, { ideaText });
  let lastText = '';
  let lastReport: Awaited<ReturnType<typeof validateVoiceV3>> | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const retryHint = lastReport
      ? `\n\nПРЕДЫДУЩАЯ ПОПЫТКА ОТКЛОНЕНА. Причина: ${lastReport.reason}. Перепиши, избегая указанных проблем.`
      : '';
    const userPrompt =
      `Идея от Юрия:\n«${ideaText}»\n\nНапиши пост (TG, 800-1200 символов).\nГолос Юрия. Финал — БЕЗ продажи клуба.` +
      retryHint;
    lastText = await callClaude(systemPrompt, userPrompt, 1800);
    lastReport = await validateVoiceV3(lastText, { voice: 'YE' });
    if (lastReport.ok) return { text: lastText, report: lastReport, attempts: attempt };
  }
  return { text: lastText, report: lastReport!, attempts: MAX_RETRIES };
}

async function generateRzPost(ideaText: string): Promise<{ text: string; report: Awaited<ReturnType<typeof validateVoiceV3>>; attempts: number }> {
  const { systemPrompt } = await buildTwinRzPrompt(pool, { ideaText });
  let lastText = '';
  let lastReport: Awaited<ReturnType<typeof validateVoiceV3>> | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const retryHint = lastReport
      ? `\n\nПРЕДЫДУЩАЯ ПОПЫТКА ОТКЛОНЕНА. Причина: ${lastReport.reason}. Перепиши.`
      : '';
    const userPrompt =
      `Идея для поста (та же что для Юрия, но от лица Виктории-участницы):\n«${ideaText}»\n\nДлина 800-1200 символов.` +
      retryHint;
    lastText = await callClaude(systemPrompt, userPrompt, 1800);
    lastReport = await validateVoiceV3(lastText, { voice: 'RZ', minCharacteristics: 2 });
    if (lastReport.ok) return { text: lastText, report: lastReport, attempts: attempt };
  }
  return { text: lastText, report: lastReport!, attempts: MAX_RETRIES };
}

async function generateCarousel(ideaText: string, yePost: string): Promise<{ slides: string[]; rawAttempts: number }> {
  const { systemPrompt, userPrompt } = await buildCarouselTextPrompt({ ideaText, yePost, totalSlides: 10 });
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const out = await callClaude(systemPrompt, userPrompt, 1500);
    let arr: unknown;
    try {
      const cleaned = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      arr = JSON.parse(cleaned);
    } catch {
      continue;
    }
    if (!Array.isArray(arr) || arr.length < 5 || !arr.every((s) => typeof s === 'string')) continue;
    const slides = arr as string[];
    const factCheck = await validateFacts(slides.join('\n'), yePost);
    if (!factCheck.ok) {
      console.error(`  carousel attempt ${attempt} invented facts: names=${factCheck.inventedNames.join(',')} numbers=${factCheck.inventedNumbers.join(',')}`);
      continue;
    }
    return { slides, rawAttempts: attempt };
  }
  return { slides: [], rawAttempts: MAX_RETRIES };
}

(async () => {
  for (let i = 0; i < IDEAS.length; i++) {
    const idea = IDEAS[i]!;
    console.log('\n' + '═'.repeat(100));
    console.log(`ИДЕЯ ${i + 1}: ${idea}`);
    console.log('═'.repeat(100));

    console.log('\n── 🎤 YE-ПОСТ ───────────────────────────────────────');
    const ye = await generateYePost(idea);
    console.log(ye.text);
    console.log(`\n[validator] ok=${ye.report.ok}  hits=${ye.report.characteristic_hits}  words=${ye.report.word_count}  attempts=${ye.attempts}  violations=${ye.report.violations.map((v) => v.marker).join(' | ') || 'none'}`);

    console.log('\n── 🎤 RZ-ПОСТ (Виктория) ─────────────────────────────');
    const rz = await generateRzPost(idea);
    console.log(rz.text);
    console.log(`\n[validator] ok=${rz.report.ok}  hits=${rz.report.characteristic_hits}  words=${rz.report.word_count}  attempts=${rz.attempts}  violations=${rz.report.violations.map((v) => v.marker).join(' | ') || 'none'}`);

    console.log('\n── 🎴 КАРУСЕЛЬ (10 слайдов) ───────────────────────────');
    const c = await generateCarousel(idea, ye.text);
    if (c.slides.length === 0) {
      console.log(`  ❌ карусель не сгенерирована (attempts=${c.rawAttempts})`);
    } else {
      c.slides.forEach((s, idx) => console.log(`  ${idx + 1}. ${s}`));
      console.log(`\n[carousel] slides=${c.slides.length}  attempts=${c.rawAttempts}`);
    }
  }

  await closePool();
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
