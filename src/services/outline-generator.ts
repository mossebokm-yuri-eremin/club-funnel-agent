// outline-generator — генерит outline лонгрида (5–8 H2 секций) для стратегии C.
// SPEC §2.6 AC-16. Юрий одобряет outline кнопками; full text пишется только после ✅.

import { z } from 'zod';
import { callAnthropic } from '../integrations/anthropic.js';
import { log } from '../observability/logger.js';

export interface OutlineSection {
  h2: string;
  summary: string;
}

export interface OutlineDraft {
  title: string;
  codeWord: string;
  sections: OutlineSection[];
}

const OutlineSchema = z.object({
  title: z.string().min(8),
  code_word: z.string().min(3).regex(/^[A-Z0-9_-]{3,32}$/),
  sections: z
    .array(
      z.object({
        h2: z.string().min(5),
        summary: z.string().min(20),
      }),
    )
    .min(5)
    .max(8),
});

const SYSTEM_PROMPT = `Ты помогаешь Юрию Еремину создать СТРУКТУРУ лонгрида для дизайнеров интерьеров.
Лонгрид — это бесплатный PDF-бонус для холодной аудитории (НЕ продаём клуб в нём).

ЗАПРЕЩЕНО упоминать конкретную цену клуба (см. sacred rule #11): цена раскрывается
только в письмах 7-8 прогрева TG-бота и на лендинге GC.

Тебе дают идею (summary + pain_tag). Выдай:
  • title — заголовок лонгрида: конкретный результат + срок + «даже если…»
  • code_word — кодовое слово для забора в Direct (3-32 символа, A-Z 0-9 _ -, например REAL-FEE-2026)
  • sections — 5-8 H2-секций по схеме StoryBrand SB7:
      HOOK + PROMISE / PROBLEM (3 слоя) / GUIDE / PLAN (3-5 шагов) /
      SUCCESS-FAILURE / PROOF (2-3 кейса) / CALL

Каждая section:
  • h2 — заголовок секции (без #, без ##)
  • summary — 1-2 предложения о чём будет секция (для одобрения Юрием)

ВЫХОД — строго JSON-объект, без markdown, без преамбул:
{
  "title": "...",
  "code_word": "REAL-FEE-2026",
  "sections": [{ "h2": "...", "summary": "..." }, ...]
}`;

export interface OutlineGeneratorInput {
  summary: string;
  painTag: string;
}

export interface OutlineGeneratorResult {
  outline: OutlineDraft;
  costUsd: number;
}

export async function generateOutline(
  input: OutlineGeneratorInput,
): Promise<OutlineGeneratorResult> {
  const response = await callAnthropic({
    mode: 'generative',
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Идея: ${input.summary}\nБоль аудитории: ${input.painTag}\n\nДай JSON outline.`,
      },
    ],
    traceTag: 'outline-generator',
    maxTokens: 1500,
    temperature: 0.7,
  });
  const raw = response.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw);
  } catch (err) {
    log.error(
      { err: (err as Error).message, preview: raw.slice(0, 200) },
      'outline-generator: JSON parse failed',
    );
    throw new Error('outline-generator: invalid JSON');
  }
  const v = OutlineSchema.safeParse(parsedRaw);
  if (!v.success) {
    log.error({ issues: v.error.issues }, 'outline-generator: schema validation failed');
    throw new Error(`outline-generator: schema invalid: ${v.error.issues[0]?.message}`);
  }
  return {
    outline: {
      title: v.data.title,
      codeWord: v.data.code_word,
      sections: v.data.sections,
    },
    costUsd: response.costUsd,
  };
}

export function renderOutlineForApproval(o: OutlineDraft): string {
  const lines: string[] = [];
  lines.push(`📖 *Заголовок:* ${o.title}`);
  lines.push(`🔑 *Кодовое слово:* \`${o.codeWord}\``);
  lines.push('');
  lines.push('*Структура (одобри / отправь на правку):*');
  o.sections.forEach((s, i) => {
    lines.push(`*${i + 1}. ${s.h2}*`);
    lines.push(`   ${s.summary}`);
  });
  return lines.join('\n');
}
