// content-edit — режим редактирования контент-пакета по инструкции пользователя.
//
// Используется когда Юрий нажал ✏️ Правка под пакетом и прислал текстовую инструкцию
// типа "сделай короче на 30%", "жёстче, с провокацией", "убери первый абзац".
//
// НЕ создаёт новую idea. Берёт ОРИГИНАЛЬНЫЙ контент пакета и просит Claude переписать
// его СОХРАНЯЯ суть, но применяя правку. Каждый артефакт (reel / tg_post / carousel /
// rz_post) редактируется отдельно. Voice-validator прогон тот же.
//
// Старый пакет → approval_status='rejected'. Новый — новый INSERT с тем же idea_id.

import type { Pool } from 'pg';
import { z } from 'zod';
import { callAnthropic } from '../integrations/anthropic.js';
import { TWIN_YE_SYSTEM_PROMPT } from '../prompts/twin-ye.v1.js';
import { TWIN_RZ_SYSTEM_PROMPT } from '../prompts/twin-rz.v1.js';
import { validateVoice } from './voice-validator.js';
import { log } from '../observability/logger.js';

const PackageRowSchema = z.object({
  id: z.string(),
  idea_id: z.string(),
  voice_code: z.string(),
  reel_caption: z.string(),
  tg_post: z.string(),
  carousel_slides: z.unknown(),
});

export interface EditContentInput {
  pkgId: string;
  instruction: string;
  tgUserId: number;
}

export interface EditContentResult {
  status: 'ok' | 'not_found' | 'error';
  newPkgId?: string;
  reason?: string;
}

function buildEditPrompt(artifactKind: string, original: string, instruction: string): string {
  return `Юрий дал команду РЕДАКТИРОВАНИЯ — это НЕ новая идея, не новый текст с нуля.
Тебе нужно отредактировать СУЩЕСТВУЮЩИЙ ${artifactKind} согласно его инструкции.

ИНСТРУКЦИЯ ЮРИЯ: ${instruction}

Если он пишет "короче на 30%" — реально сокращай текст, не пиши "делаю короче".
Если "жёстче" — меняй тональность, не дописывай слово "жёстче".
Если "убери первый абзац" — удали первый абзац.
Если "добавь кейс X" — встрой кейс органично в текст.

СОХРАНЯЙ: суть, структуру (если не сказано её менять), голос и метафоры Юрия.
МЕНЯЙ: только то, что попросил Юрий.

ОРИГИНАЛЬНЫЙ ТЕКСТ:
---
${original}
---

ВЫХОД: только новый текст, без преамбул, без markdown-разметки, без комментариев "вот изменённый вариант".`;
}

async function editText(
  systemPrompt: string,
  artifactKind: string,
  original: string,
  instruction: string,
  voiceCode: 'YE' | 'RZ',
): Promise<{ text: string; ok: boolean; reason?: string }> {
  const response = await callAnthropic({
    mode: 'generative',
    system: systemPrompt,
    messages: [{ role: 'user', content: buildEditPrompt(artifactKind, original, instruction) }],
    traceTag: `content-edit:${artifactKind}`,
    maxTokens: 4000,
    temperature: 0.6,
  });
  const text = response.text.trim();
  const report = validateVoice({ text, voice: voiceCode });
  return { text, ok: report.ok, ...(report.reason !== undefined && { reason: report.reason }) };
}

export async function editContentPackage(
  pool: Pool,
  input: EditContentInput,
): Promise<EditContentResult> {
  const r = await pool.query(
    `SELECT id, idea_id, voice_code, reel_caption, tg_post, carousel_slides
       FROM content_packages WHERE id = $1`,
    [input.pkgId],
  );
  const parsed = PackageRowSchema.safeParse(r.rows[0]);
  if (!parsed.success) {
    return { status: 'not_found', reason: 'content_package not found' };
  }
  const pkg = parsed.data;

  log.info({ pkgId: pkg.id, instruction: input.instruction.slice(0, 100) }, 'content-edit: start');

  // 3 артефакта параллельно — каждый в своём промпте.
  const [reelR, postR, slidesR] = await Promise.all([
    editText(TWIN_YE_SYSTEM_PROMPT, 'описание под рилс', pkg.reel_caption, input.instruction, 'YE'),
    editText(TWIN_YE_SYSTEM_PROMPT, 'пост в Telegram', pkg.tg_post, input.instruction, 'YE'),
    editCarousel(pkg.carousel_slides, input.instruction),
  ]);

  // Старый пакет → rejected. Новый INSERT с тем же idea_id.
  await pool.query(
    `UPDATE content_packages SET approval_status = 'rejected', updated_at = NOW() WHERE id = $1`,
    [pkg.id],
  );
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO content_packages
       (idea_id, voice_code, reel_caption, tg_post, carousel_slides, approval_status, validator_report)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6::jsonb)
     RETURNING id`,
    [
      pkg.idea_id,
      pkg.voice_code,
      reelR.text,
      postR.text,
      JSON.stringify(slidesR.slides),
      JSON.stringify({
        edited_from: pkg.id,
        instruction: input.instruction,
        reel_ok: reelR.ok,
        post_ok: postR.ok,
        edited_by_tg_user: input.tgUserId,
      }),
    ],
  );
  const newId = ins.rows[0]?.id;
  if (!newId) return { status: 'error', reason: 'insert returned no id' };

  log.info({ oldPkgId: pkg.id, newPkgId: newId }, 'content-edit: done');
  return { status: 'ok', newPkgId: newId };
}

async function editCarousel(
  originalSlides: unknown,
  instruction: string,
): Promise<{ slides: string[] }> {
  // Карусель = массив строк. Редактируем целиком, не по-слайдно.
  const arr = Array.isArray(originalSlides) ? (originalSlides as unknown[]) : [];
  const slides = arr
    .map((s) => (typeof s === 'string' ? s : ''))
    .filter((s) => s.length > 0);
  if (slides.length === 0) return { slides: [] };
  const numbered = slides.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const response = await callAnthropic({
    mode: 'generative',
    system: TWIN_YE_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          `Юрий дал команду РЕДАКТИРОВАНИЯ карусели — это НЕ новая карусель.\n` +
          `ИНСТРУКЦИЯ: ${instruction}\n\n` +
          `Если "короче на 30%" — реально сокращай, не пиши "делаю короче".\n` +
          `Если "жёстче" — меняй тональность.\n` +
          `Сохраняй количество слайдов (или меняй только если Юрий явно сказал).\n\n` +
          `ОРИГИНАЛЬНЫЕ СЛАЙДЫ:\n${numbered}\n\n` +
          `ВЫХОД — JSON-массив строк, по одной строке на слайд. Без markdown, без преамбул.`,
      },
    ],
    traceTag: 'content-edit:carousel',
    maxTokens: 4000,
    temperature: 0.6,
  });
  try {
    const cleaned = response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return { slides: parsed };
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, preview: response.text.slice(0, 120) },
      'content-edit: carousel parse failed → keep original',
    );
  }
  return { slides };
}
