// Voice analysis: 18 примеров → Sonnet 4.6 → knowledge/voice-analysis-ye.md
import { callAnthropic } from '../src/integrations/anthropic.js';
import { pool, closePool } from '../src/db/client.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const SYSTEM = [
  'Ты — лингвист-аналитик стиля. Проанализируй 18 реальных постов автора (Юрий Еремин, дизайнер интерьеров).',
  'Извлеки из этих текстов:',
  '',
  '## A) Характерные приёмы',
  'Короткие однопредложенческие абзацы? Бинарные противопоставления? Парцелляция (точка вместо запятой)? Парные повторы? Перечисли реальные приёмы которые в постах ЕСТЬ. На каждый — 1–2 примера прямой цитатой.',
  '',
  '## B) Характерные обороты',
  'Конкретные фразы и связки которые Юрий повторяет («Точка.», «И всё.», «Догадайся сам.», «Не миф.», «Я не верю.», и т.п.). Перечисли 10–15 штук из его реальных текстов.',
  '',
  '## C) Запрещённые конструкции',
  'Что в его текстах НЕТ и что бы выбилось чужеродно. Перечисли 5–10 запретов: канцелярит, «дело в том что», «таким образом», «возможно», и т.п. Для каждого — пометь почему чужеродно.',
  '',
  '## D) Структура удачного поста',
  'Как Юрий открывает (типичные хуки)? Как держит внимание (приёмы середины)? Как закрывает (короткая punch-line, вопрос-крючок, оффер-без-оффера)? Опиши паттерн структурно, с конкретными примерами из набора.',
  '',
  '## E) Тон голоса',
  '3–5 прилагательных + комментарий по каждому (что это значит в практическом письме).',
  '',
  '## F) Типичные переходы внутри поста',
  '10 примеров — как Юрий переключается между абзацами/идеями (одно слово на отдельной строке? многоточие? риторический вопрос?). С прямыми цитатами.',
  '',
  '## G) Сводные правила для AI-копирайтера',
  'В стиле «делай так — не делай так». 10 пунктов must / 10 пунктов must-not. Это бюллетень который будет вшит в системный промпт twin-ye.',
  '',
  'Возвращай чистый Markdown. Без преамбулы. Каждая секция начинается с ## заголовка.',
].join('\n');

(async () => {
  const r = await pool.query<{ source_file: string; full_text: string }>(
    `SELECT source_file, full_text FROM yury_voice_samples ORDER BY source_file`,
  );
  if (r.rows.length === 0) throw new Error('no voice samples');
  console.log(`loaded ${r.rows.length} samples`);

  const corpus = r.rows
    .map((row, i) => `### Пост ${i + 1} (${row.source_file})\n${row.full_text}`)
    .join('\n\n---\n\n');

  console.log(`corpus size: ${corpus.length} chars`);

  const result = await callAnthropic({
    mode: 'generative',
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Вот 18 реальных постов Юрия Еремина. Проанализируй стиль строго по пунктам A–G:\n\n${corpus}`,
      },
    ],
    maxTokens: 8000,
    temperature: 0.2,
    traceTag: 'voice-analyze-ye',
  });

  console.log('\n=== analysis ready ===');
  console.log(`tokens in=${result.usage.input_tokens} out=${result.usage.output_tokens}  cost=$${result.costUsd.toFixed(3)}`);

  const outPath = path.resolve(process.cwd(), 'knowledge/voice-analysis-ye.md');
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, result.text);
  console.log(`saved → ${outPath}  (${result.text.length} chars)`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); })
  .finally(() => closePool());
