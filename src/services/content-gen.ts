// content-gen — SPEC §2.5 (AC-13..15).
//
// Генерирует двухголосый контент-пакет:
//   • рилс-описание (≤ 2200 символов) — TWIN_YE
//   • пост в Telegram (≤ 4096 символов) — TWIN_YE
//   • карусель 8–10 слайдов (JSON) — TWIN_YE
//   • один пост от RZ (для альтернативной воронки)
//
// Каждый текст проходит VOICE VALIDATOR. При нарушении — retry с feedback в промпте
// (max 2 retry → итого 3 попытки на артефакт). Если после 3-й — эскалация
// (helper возвращает report и текст; caller решает — писать draft + alert или нет).
//
// СХЕМА БД: пишется ОДНА строка в content_packages (voice_code='YE'). RZ-пост хранится
// в `validator_report.rz_variant_post.{text, voice}` (текст), а отчёт voice-validator
// для RZ — в `validator_report.rz_post` (рядом с reel/tg_post/carousel). AC-13 в SPEC
// требует две строки (YE + RZ). TODO Phase 4: расширить RZ pipeline до полного пакета
// (reel/post/carousel под voice=RZ), писать два INSERT и обновить TG-bot approval flow
// (AC-22), чтобы он умел листать оба voice. Текущее упрощение оставляет RZ-вариант
// доступным в JSON для ручной публикации, а validator-отчёт — для аудита AC-14/§6.5.

import type { Pool } from 'pg';
import { z } from 'zod';
import { callAnthropic } from '../integrations/anthropic.js';
import { buildTwinYePrompt } from '../prompts/twin-ye.js';
import { buildTwinRzPrompt } from '../prompts/twin-rz.js';
import { validateVoiceV3 } from './voice-validator-v3.js';
import type { Strategy } from './strategy-chooser.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import {
  styleInstructions,
  DEFAULT_STYLE,
  type ContentStyle,
} from './user-preferences.js';

export type VoiceCode = 'YE' | 'RZ';

// Совместимость со старым формат VoiceValidatorReport — content_packages.validator_report
// JSONB историчен. Маппер v3 → legacy.
export interface VoiceValidatorReport {
  voice_code: VoiceCode;
  ok: boolean;
  violations: Array<{ marker: string; positions: number[] }>;
  missingMarkers: string[];
  required_markers_found: Array<{ marker: string; count: number }>;
  density_per_100w: number;
  score: number;
  word_count: number;
  reason?: string;
  suggestion?: string;
}

async function validateLegacy(
  text: string,
  voice: VoiceCode,
  kind: 'reel' | 'tg_post' | 'carousel' | 'rz_post' | 'generic' = 'generic',
  history?: { last7DaysText?: string; last3ReelsText?: string },
): Promise<VoiceValidatorReport> {
  const opts: Parameters<typeof validateVoiceV3>[1] = { voice, kind };
  if (history) opts.history = history;
  const v3 = await validateVoiceV3(text, opts);
  return {
    voice_code: voice,
    ok: v3.ok,
    violations: v3.violations.map((vio) => ({
      marker: vio.correction ? `${vio.marker} → ${vio.correction}` : vio.marker,
      positions: [],
    })),
    missingMarkers: v3.missing_characteristics,
    required_markers_found: [],
    density_per_100w: v3.characteristic_hits,
    score: v3.characteristic_hits,
    word_count: v3.word_count,
    ...(v3.reason ? { reason: v3.reason } : {}),
  };
}

/**
 * Загружает текст последних YE-публикаций для воронки повторов:
 *   - last7DaysText: все tg_post + reel_caption за последние 7 дней (concat)
 *   - last3ReelsText: первые ≤2200 символов из последних 3 reel_caption (для weather-hook check)
 */
async function loadHistoryContext(pool: Pool): Promise<{ last7DaysText?: string; last3ReelsText?: string }> {
  try {
    const week = await pool.query<{ tg_post: string | null; reel_caption: string | null }>(
      `SELECT tg_post, reel_caption FROM content_packages
        WHERE voice_code = 'YE' AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC LIMIT 30`,
    );
    const reels = await pool.query<{ reel_caption: string | null }>(
      `SELECT reel_caption FROM content_packages
        WHERE voice_code = 'YE' AND reel_caption IS NOT NULL
        ORDER BY created_at DESC LIMIT 3`,
    );
    return {
      last7DaysText: week.rows
        .flatMap((r) => [r.tg_post, r.reel_caption].filter((x): x is string => Boolean(x)))
        .join('\n\n'),
      last3ReelsText: reels.rows
        .map((r) => r.reel_caption ?? '')
        .filter(Boolean)
        .join('\n\n'),
    };
  } catch {
    return {};
  }
}

export interface ContentGenInput {
  ideaId: string;
  summary: string;
  painTag: string;
  strategy: Strategy;
  /** Заголовок лонгрида для A/C; null для B. */
  bonusTitle: string | null;
  /** Кодовое слово воронки — обязательно подставить в тексты A/C. */
  codeWord: string | null;
  /** Опциональные few-shot примеры (выжимки из winning_patterns). */
  winningPatterns?: string[];
  /** Стиль (длина) контента — /style команда в боте. Default short. */
  style?: ContentStyle;
  /** Релевантные выдержки из KB (knowledge_embeddings, semantic search). */
  kbExcerpts?: string;
  /** Открытия предыдущих одобренных пакетов как few-shot. */
  winningPatternsText?: string;
  /** Реальные посты Юрия как образец стиля (yury_voice_samples). */
  voiceSamplesText?: string;
}

export interface GeneratedArtifact {
  voice: VoiceCode;
  text: string;
  report: VoiceValidatorReport;
  attempts: number;
}

export interface ContentPackage {
  reelCaption: GeneratedArtifact;
  tgPost: GeneratedArtifact;
  carouselSlides: { voice: VoiceCode; slides: string[]; report: VoiceValidatorReport; attempts: number };
  rzVariantPost: GeneratedArtifact;
}

export interface ContentGenResult {
  contentPackageId: string;
  pkg: ContentPackage;
  /** Был ли хоть один артефакт принят с ошибкой валидатора (после исчерпания попыток). */
  escalated: boolean;
  totalCostUsd: number;
}

export interface ContentGenDeps {
  pool: Pool;
  callLlm?: typeof callAnthropic;
  /** override max retries (default — config.VOICE_VALIDATOR_MAX_RETRIES) */
  maxRetries?: number;
}

const REEL_MAX_CHARS = 2200;
const TG_POST_MAX_CHARS = 4096;
const CAROUSEL_SLIDES_MIN = 8;
const CAROUSEL_SLIDES_MAX = 10;

interface ArtifactSpec {
  kind: 'reel' | 'tg_post' | 'carousel' | 'rz_post';
  voice: VoiceCode;
  systemPrompt: string;
  maxChars?: number;
  /** Для carousel — JSON-массив. */
  expectJson?: boolean;
}

function buildUserPrompt(spec: ArtifactSpec, input: ContentGenInput): string {
  const style = input.style ?? DEFAULT_STYLE;
  const styleHint = styleInstructions(style);
  const parts: string[] = [];
  parts.push(`ЗАДАЧА: ${describeKind(spec.kind)}.`);
  parts.push(`Идея: ${input.summary}`);
  parts.push(`Боль аудитории: ${input.painTag}`);
  parts.push(`Стратегия воронки: ${input.strategy}`);
  parts.push(`СТИЛЬ ДЛИНЫ: ${styleHint.promptHint}`);
  if (input.bonusTitle) {
    parts.push(`Лонгрид: «${input.bonusTitle}»`);
  }
  if (input.codeWord && (input.strategy === 'A' || input.strategy === 'C')) {
    parts.push(
      `Кодовое слово воронки: «${input.codeWord}» — обязательно упомяни в тексте, ` +
        `что лонгрид забирается по этому слову в Direct.`,
    );
  }
  if (input.winningPatterns && input.winningPatterns.length > 0) {
    parts.push(`Винии-паттерны для этой боли (вдохновляйся, не копируй):`);
    for (const w of input.winningPatterns.slice(0, 3)) {
      parts.push(`  • ${w}`);
    }
  }
  // Voice samples — 3 реальных поста Юрия как образец стиля (yury_voice_samples).
  // Sonnet ОБЯЗАН повторять приёмы (парцелляция, ритм, обороты), но не дословный текст.
  if (input.voiceSamplesText && input.voiceSamplesText.trim()) {
    parts.push('\n' + input.voiceSamplesText);
  }
  // Knowledge base — реальные цитаты/кейсы Юрия. Sonnet ДОЛЖЕН ссылаться на конкретные
  // имена/цифры из этих выдержек (Анна, 50K→350K и т.п.), а не использовать абстракции.
  if (input.kbExcerpts && input.kbExcerpts.trim()) {
    parts.push('\nЗНАНИЯ ЮРИЯ (используй имена и конкретные цифры отсюда, а не выдумывай):\n' + input.kbExcerpts);
  }
  if (input.winningPatternsText && input.winningPatternsText.trim()) {
    parts.push('\n' + input.winningPatternsText);
  }
  if (spec.expectJson) {
    parts.push(
      `\nВЫХОД — строго JSON-массив из ${CAROUSEL_SLIDES_MIN}-${CAROUSEL_SLIDES_MAX} строк, ` +
        `каждая строка — текст одного слайда (50–200 символов, без markdown).`,
    );
  } else if (spec.maxChars) {
    parts.push(`\nЛимит: ≤ ${spec.maxChars} символов. Без markdown.`);
  }
  return parts.join('\n');
}

function describeKind(k: ArtifactSpec['kind']): string {
  switch (k) {
    case 'reel':
      return 'описание под рилс в Instagram (caption)';
    case 'tg_post':
      return 'пост в Telegram-канал Юрия';
    case 'carousel':
      return 'карусель из 8–10 слайдов';
    case 'rz_post':
      return 'пост от лица участницы клуба РЗ (Виктории), параллельная версия';
  }
}

const CarouselSchema = z
  .array(z.string().min(1))
  .min(CAROUSEL_SLIDES_MIN)
  .max(CAROUSEL_SLIDES_MAX);

function parseCarousel(text: string): string[] {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const payload = fence?.[1]?.trim() ?? trimmed;
  const data = JSON.parse(payload);
  return CarouselSchema.parse(data);
}

function buildFeedback(report: VoiceValidatorReport): string {
  const lines: string[] = ['ПРОШЛАЯ ПОПЫТКА НЕ ПРОШЛА VOICE VALIDATOR.'];
  if (report.violations.length > 0) {
    lines.push(
      `Найдены проблемы: ${report.violations.map((v) => v.marker).join(' | ')}. ` +
        `Перепиши, избегая указанных проблем.`,
    );
  }
  if (report.missingMarkers.length > 0 && report.density_per_100w < 2) {
    lines.push(
      `Не хватает характерных оборотов. Добавь минимум 2 из: ${report.missingMarkers.slice(0, 6).join(', ')}.`,
    );
  }
  if (report.reason) lines.push(`Причина: ${report.reason}`);
  lines.push('Сохрани содержание и структуру — поправь только язык. Не извиняйся, не пиши преамбулу.');
  return lines.join('\n');
}

async function generateOneArtifact(
  spec: ArtifactSpec,
  input: ContentGenInput,
  deps: ContentGenDeps,
  history?: { last7DaysText?: string; last3ReelsText?: string },
): Promise<{
  text: string;
  report: VoiceValidatorReport;
  attempts: number;
  costUsd: number;
}> {
  const llm = deps.callLlm ?? callAnthropic;
  const maxRetries = deps.maxRetries ?? config.VOICE_VALIDATOR_MAX_RETRIES ?? 3;
  const totalAttempts = Math.max(1, maxRetries);

  let lastText = '';
  let lastReport: VoiceValidatorReport | null = null;
  let costSum = 0;

  const baseUserPrompt = buildUserPrompt(spec, input);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const userPrompt =
      attempt === 1 || !lastReport
        ? baseUserPrompt
        : `${baseUserPrompt}\n\n---\n${buildFeedback(lastReport)}`;

    const response = await llm({
      mode: 'generative',
      system: spec.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      traceTag: `content-gen:${spec.kind}`,
      maxTokens: spec.expectJson ? 4000 : 4000,
      temperature: 0.85,
    });
    costSum += response.costUsd;
    lastText = response.text.trim();

    // Для карусели — извлекаем массив слайдов, валидируем конкатенацией слайдов.
    let textForValidator = lastText;
    if (spec.expectJson) {
      try {
        const slides = parseCarousel(lastText);
        textForValidator = slides.join('\n');
        lastText = JSON.stringify(slides);
      } catch (err) {
        log.warn(
          { ideaId: input.ideaId, kind: spec.kind, err: (err as Error).message, attempt },
          'content-gen: invalid carousel JSON',
        );
        // отметим как нарушение голоса, чтобы пойти на retry
        lastReport = {
          voice_code: spec.voice,
          ok: false,
          violations: [],
          missingMarkers: [],
          required_markers_found: [],
          density_per_100w: 0,
          score: 0,
          word_count: 0,
          reason: 'carousel JSON parse failed',
        };
        continue;
      }
    }

    // Маппим spec.kind в validator kind
    const validatorKind =
      spec.kind === 'reel' ? 'reel'
      : spec.kind === 'tg_post' ? 'tg_post'
      : spec.kind === 'carousel' ? 'carousel'
      : spec.kind === 'rz_post' ? 'rz_post'
      : 'generic';
    const report = await validateLegacy(textForValidator, spec.voice, validatorKind, history);
    lastReport = report;
    if (report.ok) {
      return { text: lastText, report, attempts: attempt, costUsd: costSum };
    }
    log.warn(
      {
        ideaId: input.ideaId,
        kind: spec.kind,
        attempt,
        reason: report.reason,
        density: report.density_per_100w,
        violations: report.violations.map((v) => v.marker),
      },
      'content-gen: voice validator failed, retrying',
    );
  }

  // Эскалация — возвращаем последнюю попытку с её repor'ом.
  return {
    text: lastText,
    report:
      lastReport ?? {
        voice_code: spec.voice,
        ok: false,
        violations: [],
        missingMarkers: [],
        required_markers_found: [],
        density_per_100w: 0,
        score: 0,
        word_count: 0,
        reason: 'no attempts produced output',
      },
    attempts: totalAttempts,
    costUsd: costSum,
  };
}

export async function generateContentPackage(
  input: ContentGenInput,
  deps: ContentGenDeps,
): Promise<ContentGenResult> {
  // v3 (2026-06-04): динамические system prompts с kind-aware блоками.
  // YE/reel и YE/tg_post — разные требования к длине и структуре.
  const yeReelBuilt = await buildTwinYePrompt(deps.pool, {
    ideaText: input.summary,
    codeWord: input.codeWord ?? null,
    kind: 'reel',
  });
  const yePostBuilt = await buildTwinYePrompt(deps.pool, {
    ideaText: input.summary,
    codeWord: input.codeWord ?? null,
    kind: 'tg_post',
  });
  const yeCarouselBuilt = await buildTwinYePrompt(deps.pool, {
    ideaText: input.summary,
    codeWord: input.codeWord ?? null,
    kind: 'carousel',
  });
  const rzBuilt = await buildTwinRzPrompt(deps.pool, {
    ideaText: input.summary,
    codeWord: input.codeWord ?? null,
    kind: 'tg_post', // RZ-вариант — длинный пост (300-600), не рилс
  });

  const specs: ArtifactSpec[] = [
    { kind: 'reel', voice: 'YE', systemPrompt: yeReelBuilt.systemPrompt, maxChars: REEL_MAX_CHARS },
    { kind: 'tg_post', voice: 'YE', systemPrompt: yePostBuilt.systemPrompt, maxChars: TG_POST_MAX_CHARS },
    { kind: 'carousel', voice: 'YE', systemPrompt: yeCarouselBuilt.systemPrompt, expectJson: true },
    { kind: 'rz_post', voice: 'RZ', systemPrompt: rzBuilt.systemPrompt, maxChars: TG_POST_MAX_CHARS },
  ];

  // 6b/6c: загружаем историю последних 7 дней + 3 reels для проверки повторов / weather hooks.
  const history = await loadHistoryContext(deps.pool);

  // Генерим последовательно, чтобы не упереться в rate-limit. При желании можно
  // распараллелить, но это даёт скачок RPS на Anthropic.
  const results = [] as Array<Awaited<ReturnType<typeof generateOneArtifact>>>;
  for (const spec of specs) {
    const r = await generateOneArtifact(spec, input, deps, history);
    results.push(r);
  }
  const [reelR, postR, carouselR, rzR] = results;
  if (!reelR || !postR || !carouselR || !rzR) {
    throw new Error('content-gen: missing artifact result');
  }

  const escalated = !reelR.report.ok || !postR.report.ok || !carouselR.report.ok || !rzR.report.ok;
  const carouselSlides = (() => {
    try {
      return JSON.parse(carouselR.text) as string[];
    } catch {
      return [];
    }
  })();
  const totalCostUsd = Number(
    (reelR.costUsd + postR.costUsd + carouselR.costUsd + rzR.costUsd).toFixed(6),
  );

  const validatorReport = {
    reel: reelR.report,
    tg_post: postR.report,
    carousel: carouselR.report,
    rz_post: rzR.report,
    escalated,
    attempts: {
      reel: reelR.attempts,
      tg_post: postR.attempts,
      carousel: carouselR.attempts,
      rz_post: rzR.attempts,
    },
  };

  const insertSql = `
    INSERT INTO content_packages (
      idea_id, voice_code, reel_caption, tg_post, carousel_slides,
      validator_report, approval_status
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending')
    RETURNING id
  `;
  const res = await deps.pool.query<{ id: string }>(insertSql, [
    input.ideaId,
    'YE', // основной voice пакета — Юрий. RZ-пост хранится в validator_report.rz_post.
          // TODO Phase 4: вторая строка с voice_code='RZ' (требует полного RZ pipeline).
    reelR.text,
    postR.text,
    JSON.stringify(carouselSlides),
    JSON.stringify({
      ...validatorReport,
      // rz_post (отчёт voice-validator для RZ) уже внутри validatorReport — НЕ затирать.
      rz_variant_post: { text: rzR.text, voice: 'RZ' as VoiceCode },
    }),
  ]);
  const contentPackageId = res.rows[0]?.id;
  if (!contentPackageId) {
    throw new Error('content-gen: insert returned no id');
  }

  log.info(
    {
      ideaId: input.ideaId,
      contentPackageId,
      escalated,
      attempts: validatorReport.attempts,
      cost_usd: totalCostUsd,
    },
    'content-gen: package saved',
  );

  return {
    contentPackageId,
    pkg: {
      reelCaption: { voice: 'YE', text: reelR.text, report: reelR.report, attempts: reelR.attempts },
      tgPost: { voice: 'YE', text: postR.text, report: postR.report, attempts: postR.attempts },
      carouselSlides: {
        voice: 'YE',
        slides: carouselSlides,
        report: carouselR.report,
        attempts: carouselR.attempts,
      },
      rzVariantPost: { voice: 'RZ', text: rzR.text, report: rzR.report, attempts: rzR.attempts },
    },
    escalated,
    totalCostUsd,
  };
}
