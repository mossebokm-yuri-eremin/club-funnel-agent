// strategy-chooser — СВЯТОЙ файл (см. CLAUDE.md «Тесты, которые обязательно зелёные»).
// SPEC §2.4 / §7.5.
//
// Принимает идею + top-1 similarity score (cosine на pgvector в bonus_library
// среди status='live'). Возвращает стратегию A/B/C + reasoning + версию промпта.
//
//   similarity > config.STRATEGY_A_MIN_SIMILARITY (default 0.85)   → A
//   similarity < config.STRATEGY_C_MAX_SIMILARITY (default 0.65)   → C
//   между ними                                                    → B (Opus решает)
//   раз в N (config.STRATEGY_B_PERIOD_IDEAS) идей                  → B (A/B-тест)
//
// ВАЖНО: в этом модуле нет I/O в БД. Векторный поиск, инкремент счётчика идей и
// апдейт ideas.strategy — на стороне вызывающего (job/handler). Так удобнее
// тестировать и держать модуль детерминированным.

import { z } from 'zod';
import { config } from '../config.js';
import { callAnthropic, parseJsonResponse } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

export const STRATEGIES = ['A', 'B', 'C'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface BonusCandidate {
  bonusId: string;
  title: string;
  /** Cosine similarity 0..1 */
  similarity: number;
  /** Историческая CR прошлых воронок с этим лонгридом (0..1). Может отсутствовать. */
  crHistory?: number;
  /** Сколько дней назад использован последний раз. */
  daysSinceLastUse?: number;
  /** Сколько раз использован за последний месяц (для индикации насыщения). */
  usesLast30d?: number;
}

export interface StrategyChooserInput {
  idea: {
    id: string;
    summary: string;
    painTag: string;
    source: 'voice' | 'text' | 'reference_adapt';
  };
  /** Кандидаты на A — топ-3 из bonus_library, отсортированы по similarity DESC. */
  topCandidates: BonusCandidate[];
  /** Сколько идей подряд НЕ выбиралась B (для A/B-теста). */
  ideasSinceLastB: number;
  /** Метрики A vs B за последние 30 дней — для решения о B-тесте. */
  abMetrics?: {
    crA: number; // 0..1
    crB: number; // 0..1
  };
  /** Принудительно зафиксированный bonus (из ideas.forced_bonus_id). Если есть — A гарантировано. */
  forcedBonusId?: string;
}

export interface StrategyDecision {
  strategy: Strategy;
  reasoning: string;
  /** UUID лонгрида для стратегии A; null для B/C. */
  bonusId: string | null;
  /** Имя+версия промпта, который должен использовать content-generator. */
  recommendedPromptVersion: string;
  /** Сложилось ли решение детерминированно по правилам (без LLM). */
  deterministic: boolean;
}

export interface StrategyChooserDeps {
  /** Optional LLM hook для тестов. По умолчанию — Anthropic Opus. */
  callLlm?: typeof callAnthropic;
}

const LlmDecisionSchema = z.object({
  strategy: z.enum(STRATEGIES),
  reason: z.string().min(3),
  bonus_id: z.string().nullable().optional(),
});

const SYSTEM_PROMPT = `Ты выбираешь стратегию воронки для идеи Юрия Еремина.

Варианты:
  A — использовать существующий лонгрид из bonus_library (доставится в Direct).
  B — воронка БЕЗ лонгрида (приветствие → сразу TG-канал клуба).
  C — создать НОВЫЙ лонгрид специально под эту идею.

Правила (тебе передают input.shouldDelegateToLLM=true только в зоне 0.65–0.85):
  • similarity > 0.85 → решение уже принято A; ты сюда не вызываешься.
  • similarity < 0.65 → решение уже принято C; ты сюда не вызываешься.
  • 0.65 ≤ similarity ≤ 0.85 → реши сам, учитывая:
      — насыщение: usesLast30d > 5 или CR падает → склон к C;
      — свежесть: daysSinceLastUse < 14 — продолжаем «качать», склон к A;
      — новизна угла: идея вводит новый угол → склон к C.

Выход — строго JSON, без markdown:
{ "strategy": "A|B|C",
  "reason":   "1–2 предложения для Юрия, разговорно, конкретно",
  "bonus_id": "uuid|null"   }

Никаких преамбул, только JSON.`;

const STRATEGY_PROMPT_MAP: Record<Strategy, string> = {
  A: 'twin_ye@v1+bonus_reuse',
  B: 'twin_ye@v1+no_bonus',
  C: 'twin_ye@v1+bonus_create',
};

function clampNumber(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Главная точка входа. Возвращает решение, не трогая БД. */
export async function chooseStrategy(
  input: StrategyChooserInput,
  deps: StrategyChooserDeps = {},
): Promise<StrategyDecision> {
  const aMin = config.STRATEGY_A_MIN_SIMILARITY;
  const cMax = config.STRATEGY_C_MAX_SIMILARITY;
  const bPeriod = config.STRATEGY_B_PERIOD_IDEAS;

  // 1) Forced bonus — Юрий явно указал лонгрид в голосовом.
  if (input.forcedBonusId) {
    const forced = input.topCandidates.find((c) => c.bonusId === input.forcedBonusId);
    return {
      strategy: 'A',
      reasoning: forced
        ? `Юрий привязал лонгрид «${forced.title}» вручную — берём его.`
        : `Юрий явно указал bonus_id=${input.forcedBonusId} — стратегия A.`,
      bonusId: input.forcedBonusId,
      recommendedPromptVersion: STRATEGY_PROMPT_MAP.A,
      deterministic: true,
    };
  }

  const top1 = input.topCandidates[0];
  const sim = top1 ? clampNumber(top1.similarity, 0, 1) : 0;

  // 2) Жёсткие пороги — детерминированные ветки.
  if (top1 && sim > aMin) {
    const crStr = top1.crHistory !== undefined ? `${(top1.crHistory * 100).toFixed(1)}%` : 'н/д';
    const ageStr =
      top1.daysSinceLastUse !== undefined ? `${top1.daysSinceLastUse} дн. назад` : 'давно';
    return {
      strategy: 'A',
      reasoning: `Беру лонгрид «${top1.title}» (sim=${sim.toFixed(2)}, CR прошлых воронок ${crStr}, последняя публикация ${ageStr}).`,
      bonusId: top1.bonusId,
      recommendedPromptVersion: STRATEGY_PROMPT_MAP.A,
      deterministic: true,
    };
  }

  if (!top1 || sim < cMax) {
    // Cold start fallback: если bonus_library пустая и STRATEGY_COLD_START_FALLBACK_B=true —
    // делаем B (быструю карусель без лонгрида), чтобы пайплайн не упирался в AC-16 outline approval.
    if (!top1 && config.STRATEGY_COLD_START_FALLBACK_B) {
      return {
        strategy: 'B',
        reasoning: `bonus_library пустая (cold start). STRATEGY_COLD_START_FALLBACK_B=true → быстрая карусель-крючок без лонгрида.`,
        bonusId: null,
        recommendedPromptVersion: STRATEGY_PROMPT_MAP.B,
        deterministic: true,
      };
    }
    return {
      strategy: 'C',
      reasoning: top1
        ? `Близких лонгридов нет (top1 sim=${sim.toFixed(2)} < ${cMax}). Делаем новый лонгрид под идею.`
        : `bonus_library пустая или не вернула кандидатов. Делаем новый лонгрид (cold start).`,
      bonusId: null,
      recommendedPromptVersion: STRATEGY_PROMPT_MAP.C,
      deterministic: true,
    };
  }

  // 3) A/B-тест: раз в bPeriod идей выбираем B, если разрыв A vs B мал.
  if (input.ideasSinceLastB >= bPeriod && input.abMetrics) {
    const { crA, crB } = input.abMetrics;
    const ratio = crB > 0 ? crA / crB : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ratio) && ratio < 1.5) {
      return {
        strategy: 'B',
        reasoning: `A/B-тест: ${input.ideasSinceLastB} идей подряд без B, а разрыв CR A/B=${ratio.toFixed(2)} < 1.5. Гоняем B.`,
        bonusId: null,
        recommendedPromptVersion: STRATEGY_PROMPT_MAP.B,
        deterministic: true,
      };
    }
  }

  // 4) Серая зона 0.65..0.85 — спрашиваем Opus.
  const llm = deps.callLlm ?? callAnthropic;
  const userMessage = {
    idea: input.idea,
    candidates: input.topCandidates.map((c) => ({
      title: c.title,
      similarity: c.similarity,
      cr_history: c.crHistory ?? null,
      days_since_last_use: c.daysSinceLastUse ?? null,
      uses_last_30d: c.usesLast30d ?? null,
    })),
    shouldDelegateToLLM: true,
    thresholds: { a_min: aMin, c_max: cMax },
  };
  const response = await llm({
    mode: 'thinking',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: JSON.stringify(userMessage) }],
    traceTag: 'strategy-chooser',
    // Серая зона требует именно «подумать» — даём бюджет, но небольшой:
    // решение тактическое, не лонгрид.
    thinkingBudgetTokens: Math.min(8000, config.ANTHROPIC_THINKING_BUDGET_TOKENS),
    maxTokens: 1024,
  });

  let rawJson: unknown = null;
  try {
    rawJson = parseJsonResponse(response.text);
  } catch (err) {
    log.warn(
      { ideaId: input.idea.id, err: (err as Error).message },
      'strategy-chooser: LLM response is not JSON, fallback to A on top1',
    );
  }
  const parsed = LlmDecisionSchema.safeParse(rawJson);
  if (!parsed.success) {
    log.error(
      { ideaId: input.idea.id, raw: response.text.slice(0, 500), issues: parsed.error.issues },
      'strategy-chooser: invalid LLM JSON, fallback to A on top1',
    );
    return {
      strategy: 'A',
      reasoning: `LLM не вернула валидный JSON — fallback на top1 «${top1.title}» (sim=${sim.toFixed(2)}).`,
      bonusId: top1.bonusId,
      recommendedPromptVersion: STRATEGY_PROMPT_MAP.A,
      deterministic: false,
    };
  }

  const decided = parsed.data.strategy;
  let bonusId: string | null = null;
  if (decided === 'A') {
    // Берём bonus_id из ответа, если LLM указала валидный uuid из топа;
    // иначе — top1 (LLM согласилась, но id не назвала).
    const guess = parsed.data.bonus_id?.trim();
    const fromTop = input.topCandidates.find((c) => c.bonusId === guess);
    bonusId = fromTop ? fromTop.bonusId : top1.bonusId;
  }
  return {
    strategy: decided,
    reasoning: parsed.data.reason,
    bonusId,
    recommendedPromptVersion: STRATEGY_PROMPT_MAP[decided],
    deterministic: false,
  };
}
