// idea-builder: Превращает raw_transcript из голосового (или текстовое сообщение)
// в структурированную идею. SPEC §2.3 (AC-7..9).
//
// Решает три задачи:
//  1) классифицирует тип запроса (контент / реф-интейк / комментарий) — это
//     уже сделано upstream (TG bot handler), сюда приходят только идеи контента;
//  2) извлекает: тему, угол подачи, hook, целевую боль, формат, стадию
//     путешествия 0→1..4→5;
//  3) пишет результат в БД и переводит idea.status → 'strategy_chosen'-ready.
//
// LLM: Opus + extended thinking с TWIN_YE как системным контекстом (см. SPEC §6.11).

import type { Pool } from 'pg';
import { z } from 'zod';
import { callAnthropic, parseJsonResponse } from '../integrations/anthropic.js';
import { TWIN_YE_SYSTEM_PROMPT } from '../prompts/twin-ye.v1.js';
import { log } from '../observability/logger.js';

export const PAIN_TAGS = [
  'personal_brand',
  'client_flow',
  'check_growth',
  'scaling',
  'network',
] as const;

export type PainTag = (typeof PAIN_TAGS)[number];

export const JOURNEY_STAGES = ['0_to_1', '1_to_2', '2_to_3', '3_to_4', '4_to_5'] as const;
export type JourneyStage = (typeof JOURNEY_STAGES)[number];

export const CONTENT_FORMATS = ['reel', 'post', 'longread'] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

const IdeaPlanSchema = z.object({
  topic: z.string().min(3),
  angle: z.string().min(3),
  hook: z.string().min(3).max(280),
  pain_tag: z.enum(PAIN_TAGS),
  stage: z.enum(JOURNEY_STAGES),
  format: z.enum(CONTENT_FORMATS),
  summary: z.string().min(3).max(200),
});

export type IdeaPlan = z.infer<typeof IdeaPlanSchema>;

const SYSTEM_PROMPT_HEAD = `${TWIN_YE_SYSTEM_PROMPT}

---

РЕЖИМ: IDEA-BUILDER. Сейчас ты не пишешь пост — ты структурируешь сырую идею
из голосового в стандартизированный план для дальнейшей генерации.

ВЫХОД — строго один JSON-объект, без markdown, без преамбул:
{
  "topic":   "одна строка, о чём идея",
  "angle":   "под каким углом подаём (1-2 фразы голосом Юрия)",
  "hook":    "хук-первая фраза (≤ 280 символов, провокация)",
  "pain_tag":"personal_brand | client_flow | check_growth | scaling | network",
  "stage":   "0_to_1 | 1_to_2 | 2_to_3 | 3_to_4 | 4_to_5",
  "format":  "reel | post | longread",
  "summary": "одно предложение ≤ 200 символов — как сядет в БД ideas.summary"
}

Боли:
  personal_brand — позиционирование, авторитет, узнавание.
  client_flow    — где брать заявки, лидген, Авито vs нет.
  check_growth   — поднять цену, перестать стесняться, не работать в минус.
  scaling        — команда, студия, делегирование, рост от одиночки.
  network        — окружение, нетворк, отношения с подрядчиками/мебельщиками.

Стадии путешествия:
  0_to_1 — холодный читатель → подписчик.
  1_to_2 — подписчик → активный читатель.
  2_to_3 — активный → лид (директ).
  3_to_4 — лид → клиент клуба (оплата).
  4_to_5 — клиент → амбассадор / win-pattern.

Только JSON, ничего лишнего.`;

export interface IdeaBuilderDeps {
  pool: Pool;
}

export interface BuildIdeaInput {
  /** UUID существующей строки в ideas */
  ideaId: string;
  /** raw_transcript (для voice) или текст сообщения (для text) */
  rawText: string;
  /** voice | text | reference_adapt — для логов (SPEC §5.4 IdeaSource) */
  source: 'voice' | 'text' | 'reference_adapt';
}

export interface BuildIdeaResult {
  ideaId: string;
  plan: IdeaPlan;
  costUsd: number;
}

export async function buildIdea(
  input: BuildIdeaInput,
  deps: IdeaBuilderDeps,
): Promise<BuildIdeaResult> {
  if (!input.rawText.trim()) {
    throw new Error('idea-builder: empty rawText');
  }

  const response = await callAnthropic({
    mode: 'thinking',
    system: SYSTEM_PROMPT_HEAD,
    messages: [
      {
        role: 'user',
        content: `Сырой ввод от Юрия (${input.source}):\n\n${input.rawText.trim()}\n\nВерни только JSON.`,
      },
    ],
    traceTag: 'idea-builder',
  });

  const rawJson = parseJsonResponse(response.text);
  const parsed = IdeaPlanSchema.safeParse(rawJson);
  if (!parsed.success) {
    log.error(
      { ideaId: input.ideaId, issues: parsed.error.issues, raw: response.text.slice(0, 500) },
      'idea-builder: invalid JSON from LLM',
    );
    throw new Error(`idea-builder: LLM returned invalid JSON shape (${parsed.error.message})`);
  }
  const plan = parsed.data;

  // Здесь только фиксируем извлечённые поля. Переход status='new' → strategy_*
  // делает strategy-chooser на следующем шаге.
  const res = await deps.pool.query<{ id: string }>(
    `UPDATE ideas
        SET pain_tag = $2,
            summary  = $3
      WHERE id = $1
      RETURNING id`,
    [input.ideaId, plan.pain_tag, plan.summary],
  );
  if (res.rowCount === 0) {
    throw new Error(`idea-builder: idea ${input.ideaId} not found`);
  }

  log.info(
    {
      ideaId: input.ideaId,
      pain_tag: plan.pain_tag,
      stage: plan.stage,
      format: plan.format,
      cost_usd: response.costUsd,
    },
    'idea-builder: plan stored',
  );

  return { ideaId: input.ideaId, plan, costUsd: response.costUsd };
}
