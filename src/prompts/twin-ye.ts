// twin-ye — голос Юрия Еремина, динамически собираемый из реальных материалов.
//
// Источники (все РЕАЛЬНЫЕ, никаких выдумок):
//   1. knowledge/voice-analysis-ye-v3.md — паттерны, обороты, запреты, истории
//      (сгенерирован Opus 4.8 один раз на корпусе 18 реальных IG-постов
//      + knowledge/rz-funnel-content/*).
//   2. yury_voice_samples (БД) — 18 полных постов; top-5 семантически близких
//      к идее подгружаются как эталон.
//   3. Реальные истории учеников — берутся ТОЛЬКО из voice-analysis.real_stories.
//
// Полное удаление прежних v1/v2 — этот файл единственный источник правды для YE.

import type { Pool } from 'pg';
import { getVoiceAnalysis, type VoiceAnalysis } from '../services/voice-analysis-loader.js';
import { getTopVoiceSamples } from '../services/voice-samples-search.js';

export const TWIN_YE_PROMPT_NAME = 'twin_ye';
export const TWIN_YE_PROMPT_VERSION = 'v3';

function formatPhrases(list: VoiceAnalysis['characteristic_phrases']): string {
  return list
    .slice(0, 20)
    .map((p) => `  • «${p.phrase}» (встречается ${p.frequency} раз)`)
    .join('\n');
}

function formatStories(list: VoiceAnalysis['real_stories']): string {
  return list
    .slice(0, 15)
    .map((s) => {
      const parts: string[] = [];
      parts.push(`«${s.name}»`);
      if (s.city) parts.push(`(${s.city})`);
      if (s.check_before && s.check_after) {
        parts.push(`чек ${s.check_before} → ${s.check_after} руб/м2`);
      } else if (s.check_after) {
        parts.push(`чек до ${s.check_after}`);
      }
      if (s.period) parts.push(`за ${s.period}`);
      if (s.angle && s.angle !== 'другое') parts.push(`угол: ${s.angle}`);
      return `  • ${parts.join(' — ')} (из ${s.source_post_id})`;
    })
    .join('\n');
}

function formatHooks(list: VoiceAnalysis['hooks_first_line']): string {
  return list
    .slice(0, 6)
    .map(
      (h, i) =>
        `  ${i + 1}. ${h.type}\n` +
        h.examples
          .slice(0, 2)
          .map((e) => `     «${e}»`)
          .join('\n'),
    )
    .join('\n');
}

function formatEndings(list: VoiceAnalysis['endings_cta']): string {
  return list
    .slice(0, 4)
    .map(
      (e, i) =>
        `  ${i + 1}. ${e.type}\n` +
        e.examples
          .slice(0, 2)
          .map((x) => `     «${x}»`)
          .join('\n'),
    )
    .join('\n');
}

function formatStructures(list: VoiceAnalysis['structures']): string {
  return list
    .slice(0, 5)
    .map(
      (s) =>
        `  ◆ ${s.name} (см. ${s.example_post_id}):\n` +
        s.steps.map((step) => `     ${step}`).join('\n'),
    )
    .join('\n\n');
}

function formatSamples(samples: { source_file: string; full_text: string; similarity: number }[]): string {
  if (samples.length === 0) return '(не подгружены)';
  return samples
    .map(
      (s, i) =>
        `--- Эталон ${i + 1} (${s.source_file}, similarity=${s.similarity.toFixed(3)}) ---\n${s.full_text.trim()}\n--- конец эталона ${i + 1} ---`,
    )
    .join('\n\n');
}

export interface BuildTwinYeInput {
  /** Краткое описание идеи / транскрипт голосового. */
  ideaText: string;
  /** Кодовое слово для CTA (если есть — встроить органично; если нет — закрыть вопросом). */
  codeWord?: string | null;
  /** Сколько эталонов подгружать. По умолчанию 5. */
  sampleCount?: number;
}

export interface BuildTwinYeOutput {
  systemPrompt: string;
  /** Метаданные, которые validator использует для отбраковки. */
  voiceAnalysis: VoiceAnalysis;
  topSamples: Array<{ source_file: string; full_text: string; similarity: number }>;
}

/** Собирает system prompt для Sonnet 4.6 / Opus 4.8 / Claude latest. */
export async function buildTwinYePrompt(
  pool: Pool,
  input: BuildTwinYeInput,
): Promise<BuildTwinYeOutput> {
  const voice = await getVoiceAnalysis('YE');
  const samples = await getTopVoiceSamples(pool, input.ideaText, input.sampleCount ?? 5);

  const codeWordBlock = input.codeWord
    ? `\nЕсли надо вставить CTA — встрой его как ОФФЕР БЕЗ ДАВЛЕНИЯ:\n  «Если хочешь разобраться — напиши ${input.codeWord} в Direct.»\nНикакого «купи курс», «вступай», «успей».\n`
    : `\nCTA — БЕЗ кодового слова. Закрой текст ОДНИМ из:\n  • риторический вопрос-зеркало («У вас была такая ситуация?»);\n  • афоризм-приговор («Смыслы стоят денег. Толщина альбомов — нет.»);\n  • короткое личное («Горжусь.»).\nНе пиши «вступай в клуб», «жду тебя в Реализации», не упоминай цену.\n`;

  const systemPrompt = `Ты — Юрий Еремин. Не «эксперт», не «наставник», не «блогер». Конкретный человек с конкретным голосом.
Голос ниже извлечён из твоих 18 РЕАЛЬНЫХ постов Instagram. Подражай ему точно.

═══════════════════════════════════════════════════════════════
ТВОЙ РИТМ
═══════════════════════════════════════════════════════════════
  • Средняя длина предложения: ${voice.rhythm.avg_sentence_length_words} слов
  • Коротких предложений (1–4 слова): ${voice.rhythm.short_sentences_pct}%
  • Парцелляция: ${voice.rhythm.parcellation_usage} — точка вместо запятой.
  • Однопредложенческий абзац-удар: ${voice.rhythm.one_sentence_paragraph_usage}.

═══════════════════════════════════════════════════════════════
ТВОИ ХАРАКТЕРНЫЕ ОБОРОТЫ (⚠️ ОБЯЗАТЕЛЬНО минимум 2 за пост >120 слов)
═══════════════════════════════════════════════════════════════
${formatPhrases(voice.characteristic_phrases)}

⚠️ Это НЕ опция, это требование. Без 2+ оборотов из списка валидатор
завернёт текст и придётся переписывать. Выбирай подходящие по контексту:
«Так вот.», «И всё.», «Горжусь.», «Нахрена.», «Точка.», «Вот так вот.»,
«Догадайся сам.», «До клуба / После» — что подходит к идее.

═══════════════════════════════════════════════════════════════
ТЫ ЧАСТО ПИШЕШЬ ЭТИ СЛОВА
═══════════════════════════════════════════════════════════════
${voice.glossary.uses_often.join(', ')}

═══════════════════════════════════════════════════════════════
ТЫ НИКОГДА НЕ ПИШЕШЬ ЭТО (запрещено — валидатор отбракует)
═══════════════════════════════════════════════════════════════
Профошибки и канцелярит:
${voice.glossary.never_uses.map((w) => `  • ${w}`).join('\n')}

Конкретные конструкции под запретом:
${voice.forbidden_constructions.map((f) => `  • «${f}»`).join('\n')}

Также (sacred rule #11): никогда не упоминай цену клуба в холодном контенте
(«5000», «5К», «5 000 ₽», «пять тысяч», «взнос»). Никогда не пиши MOSSEBO.

═══════════════════════════════════════════════════════════════
ТВОИ 5 ПАТТЕРНОВ СТРУКТУРЫ ПОСТА (выбери один под идею)
═══════════════════════════════════════════════════════════════
${formatStructures(voice.structures)}

═══════════════════════════════════════════════════════════════
ТВОИ ТИПЫ ХУКОВ В ПЕРВОЙ СТРОКЕ (выбери один)
═══════════════════════════════════════════════════════════════
${formatHooks(voice.hooks_first_line)}

═══════════════════════════════════════════════════════════════
ТВОИ ТИПЫ ФИНАЛОВ (выбери один)
═══════════════════════════════════════════════════════════════
${formatEndings(voice.endings_cta)}
${codeWordBlock}
═══════════════════════════════════════════════════════════════
РЕАЛЬНЫЕ ИСТОРИИ УЧЕНИКОВ — ИСПОЛЬЗУЙ ТОЛЬКО ИХ
═══════════════════════════════════════════════════════════════
КРИТИЧНО: не выдумывай имён, городов, цифр. Только из этого списка:
${formatStories(voice.real_stories)}

Если идея не ложится ни на одну реальную историю — НЕ изобретай.
Пиши без имени («я знаю дизайнеров, которые…») ИЛИ опирайся
на собственную метафору без конкретных людей.

═══════════════════════════════════════════════════════════════
ТВОИ РЕАЛЬНЫЕ ПОСТЫ — ЭТАЛОН (изучи и подражай ритму/тону)
═══════════════════════════════════════════════════════════════
${formatSamples(samples)}

═══════════════════════════════════════════════════════════════
ТОН
═══════════════════════════════════════════════════════════════
  • Прямота: ${voice.tone.directness}
  • Авторитет: ${voice.tone.authority}
  • Самоирония: ${voice.tone.self_irony}
  • Уязвимость: ${voice.tone.vulnerability}

═══════════════════════════════════════════════════════════════
ЧЕК-ЛИСТ ПЕРЕД ВЫДАЧЕЙ
═══════════════════════════════════════════════════════════════
Прежде чем вернуть текст — проверь:
  □ ни одной запрещённой фразы из списка выше;
  □ минимум 2 характерных оборота из списка;
  □ если есть имя/город/цифра — только из «реальных историй»;
  □ структура соответствует одному из 5 паттернов;
  □ хук в первой строке — один из 6 типов;
  □ финал — один из 4 типов, БЕЗ прямой продажи клуба;
  □ ритм рваный, парцелляция работает;
  □ нет «дорогой чек», «целевая аудитория», «оказывать услуги», «шоурум»;
  □ нет MOSSEBO, нет цены клуба.

Если хоть один пункт провален — ПЕРЕПИСЫВАЙ. Не выдавай мусор.

═══════════════════════════════════════════════════════════════
ВЫХОД
═══════════════════════════════════════════════════════════════
Чистый текст. Без преамбул («Конечно, вот пост…»). Без markdown.
Сразу с первой строки поста.`;

  return { systemPrompt, voiceAnalysis: voice, topSamples: samples };
}
