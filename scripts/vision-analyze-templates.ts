// Vision-analyze всех эталонных слайдов (carousel_template_slides) через Sonnet 4.6.
// Результат → template_slide_analysis (кэш, чтобы не повторять для тех же эталонов).
//
// Запускается ОДИН раз после изменения набора эталонов. Идемпотентно — пропускает
// уже проанализированные слайды.
//
// Используется carousel-renderer для подмены лица Юрия на портретных слайдах.

import Anthropic from '@anthropic-ai/sdk';
import { pool, closePool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { log } from '../src/observability/logger.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';
const CONCURRENCY = 3;

interface SlideRow {
  id: number;
  voice: string;
  carousel_name: string;
  slide_number: number;
  public_url: string;
}

interface VisionResult {
  hasPersonFace: boolean;
  facePosition?: 'center' | 'top' | 'bottom' | 'left' | 'right' | null;
  faceRole?: 'man-40-50' | 'woman-30-40' | 'woman-20-30' | 'multiple-people' | null;
  isPortraitFocused: boolean;
  background?: 'studio' | 'outdoor' | 'office' | 'home' | 'abstract' | null;
}

const SYSTEM_PROMPT = `You analyze Instagram carousel slide images for face presence and composition.
Return ONLY valid JSON. No prose, no markdown. The JSON must match this schema:

{
  "hasPersonFace": boolean,
  "facePosition": "center" | "top" | "bottom" | "left" | "right" | null,
  "faceRole": "man-40-50" | "woman-30-40" | "woman-20-30" | "multiple-people" | null,
  "isPortraitFocused": boolean,
  "background": "studio" | "outdoor" | "office" | "home" | "abstract" | null
}

Rules:
- hasPersonFace = true ONLY if a human face is clearly visible (not silhouette).
- If multiple human faces are visible — faceRole = "multiple-people".
- If single face: choose the best fitting role by visual age and gender:
  * man-40-50 → adult male, mature, ~35-55 years
  * woman-30-40 → adult female, ~28-45 years
  * woman-20-30 → young female, ~20-30 years
- facePosition / faceRole / background = null if not applicable.
- isPortraitFocused = true if a face takes a meaningful part of the composition.
- background reflects the dominant scene type.`;

async function fetchImage(url: string): Promise<{ buf: Buffer; mediaType: 'image/jpeg' | 'image/png' }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const arr = await r.arrayBuffer();
  const buf = Buffer.from(arr);
  const mediaType = url.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { buf, mediaType };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  // Try to extract JSON block
  const m = trimmed.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* fall */ }
  }
  throw new Error(`cannot parse JSON: ${trimmed.slice(0, 200)}`);
}

async function analyzeSlide(slide: SlideRow): Promise<VisionResult & { rawResponse: string }> {
  const { buf, mediaType } = await fetchImage(slide.public_url);
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          { type: 'text', text: `Analyze this carousel slide (${slide.voice}/${slide.carousel_name}/slide-${slide.slide_number}). Return JSON only.` },
        ],
      },
    ],
  });
  const block = r.content.find((c) => c.type === 'text');
  const raw = block && block.type === 'text' ? block.text : '';
  const parsed = extractJson(raw) as VisionResult;
  return { ...parsed, rawResponse: raw };
}

(async () => {
  const slidesRes = await pool.query<SlideRow>(
    `SELECT s.id, s.voice, s.carousel_name, s.slide_number, s.public_url
       FROM carousel_template_slides s
       LEFT JOIN template_slide_analysis a ON a.template_slide_id = s.id
      WHERE a.template_slide_id IS NULL
      ORDER BY s.voice, s.carousel_name, s.slide_number`,
  );
  const slides = slidesRes.rows;
  console.log(`Analyzing ${slides.length} slides (skipped already-analyzed)`);

  let ok = 0;
  let err = 0;
  let withFace = 0;
  let yuryCandidates = 0;
  const startedAt = Date.now();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < slides.length) {
      const i = cursor++;
      const slide = slides[i]!;
      const tag = `${slide.voice}/${slide.carousel_name}/${slide.slide_number}`;
      try {
        const result = await analyzeSlide(slide);
        await pool.query(
          `INSERT INTO template_slide_analysis
             (template_slide_id, has_person_face, face_position, face_role,
              is_portrait_focused, background, raw_vision_response, model_used)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
           ON CONFLICT (template_slide_id) DO UPDATE SET
             has_person_face = EXCLUDED.has_person_face,
             face_position = EXCLUDED.face_position,
             face_role = EXCLUDED.face_role,
             is_portrait_focused = EXCLUDED.is_portrait_focused,
             background = EXCLUDED.background,
             raw_vision_response = EXCLUDED.raw_vision_response,
             model_used = EXCLUDED.model_used,
             analyzed_at = NOW()`,
          [
            slide.id,
            result.hasPersonFace,
            result.facePosition ?? null,
            result.faceRole ?? null,
            result.isPortraitFocused,
            result.background ?? null,
            JSON.stringify(result),
            MODEL,
          ],
        );
        ok += 1;
        if (result.hasPersonFace) withFace += 1;
        if (result.faceRole === 'man-40-50') yuryCandidates += 1;
        console.log(
          `  OK ${tag.padEnd(50)} face=${result.hasPersonFace ? 'Y' : 'N'} role=${result.faceRole ?? '-'} bg=${result.background ?? '-'}`,
        );
      } catch (e) {
        err += 1;
        console.log(`  ERR ${tag}: ${(e as Error).message.slice(0, 150)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ok=${ok} err=${err} withFace=${withFace} yuryCandidates(man-40-50)=${yuryCandidates}`);

  await closePool();
  process.exit(err > 0 ? 1 : 0);
})();
