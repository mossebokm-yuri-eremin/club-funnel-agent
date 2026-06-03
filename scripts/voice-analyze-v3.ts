// voice-analyze-v3 — экстракция голоса Юрия из 18 РЕАЛЬНЫХ постов + knowledge/rz-funnel-content/*.
// Запуск: один раз. Результат → knowledge/voice-analysis-ye-v3.md (JSON в markdown-обвязке).
// Модель: claude-opus-4-8 — нужен сильный анализ паттернов, не генерация.

import Anthropic from '@anthropic-ai/sdk';
import { pool, closePool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MODEL = 'claude-opus-4-8';
const KNOWLEDGE_DIR = '/opt/club-funnel/knowledge';
const OUT_FILE = '/opt/club-funnel/knowledge/voice-analysis-ye-v3.md';

const KNOWLEDGE_FILES = [
  'rz-funnel-content/01-audience-portrait.md',
  'rz-funnel-content/02-yuri-quotes.md',
  'rz-funnel-content/03-cases-methodology.md',
  'rz-funnel-content/04-live-language-cases.md',
  'rz-funnel-content/06-voice-mastering.md',
  'voice-analysis-ye.md',
];

const SYSTEM = `Ты — лингвист-аналитик. Твоя задача: извлечь точные речевые паттерны
из корпуса РЕАЛЬНЫХ текстов Юрия Еремина (наставника дизайнеров интерьеров).

Тебе будут даны:
1) 18 полных постов из его Instagram (OCR с реальных скриншотов)
2) Дополнительные материалы из knowledge/ — цитаты, кейсы, портрет аудитории

Ты должен вернуть СТРОГО валидный JSON без markdown-обёртки, без преамбулы, такой структуры:

{
  "characteristic_phrases": [
    {"phrase": "точная фраза", "frequency": число, "contexts": ["короткая цитата из поста"]}
  ],
  "rhythm": {
    "avg_sentence_length_words": число,
    "short_sentences_pct": число,
    "long_sentences_pct": число,
    "parcellation_usage": "high или medium или low",
    "one_sentence_paragraph_usage": "high или medium или low"
  },
  "glossary": {
    "uses_often": ["слова которые Юрий явно использует"],
    "never_uses": ["слова которых нет ни в одном посте, маркетинг-штампы"],
    "professional_terms": {"чек": "высокий/низкий/целевой", "клиент": "платёжеспособный/премиум/эконом"}
  },
  "structures": [
    {"name": "название паттерна", "steps": ["1.", "2.", "3."], "example_post_id": "post-N"}
  ],
  "real_stories": [
    {"name": "имя", "city": "город", "check_before": число_или_null, "check_after": число_или_null, "period": "строка", "angle": "позиционирование или упаковка или другое", "source_post_id": "post-N"}
  ],
  "forbidden_constructions": [
    "точные фразы которых Юрий НИКОГДА не пишет (маркетинг-штампы, канцелярит, профошибки)"
  ],
  "hooks_first_line": [
    {"type": "название типа хука", "examples": ["реальная первая строка из поста"]}
  ],
  "endings_cta": [
    {"type": "тип финала", "examples": ["реальная последняя строка"]}
  ],
  "tone": {
    "directness": "high или medium или low",
    "self_irony": "high или medium или low",
    "authority": "high или medium или low",
    "vulnerability": "high или medium или low"
  }
}

ПРАВИЛА:
- characteristic_phrases — фразы встречающиеся минимум 2 раза. До 20 штук.
- real_stories — только если есть имя ИЛИ конкретные цифры в постах. До 15 кейсов.
- forbidden_constructions — фразы которых НЕТ ни в одном посте. До 30 штук.
- never_uses — добавь ТОЛЬКО профошибки и маркетинг-штампы (дорогой чек, целевая аудитория, оказывать услуги, шоурум, и т.д.). До 25 штук.
- Все числа — integers. Все строки — двойные кавычки.
- НИКАКОГО markdown, преамбулы, объяснений. Только JSON.`;

(async () => {
  const samplesRes = await pool.query<{ source_file: string; full_text: string }>(
    `SELECT source_file, full_text FROM yury_voice_samples ORDER BY source_file`,
  );
  const posts = samplesRes.rows
    .map((r) => `=== ${r.source_file} ===\n${r.full_text.trim()}`)
    .join('\n\n');

  const knowledgeBlocks: string[] = [];
  for (const f of KNOWLEDGE_FILES) {
    try {
      const txt = await readFile(join(KNOWLEDGE_DIR, f), 'utf8');
      knowledgeBlocks.push(`=== ${f} ===\n${txt.slice(0, 8000)}`);
    } catch {
      // skip missing
    }
  }

  const fullCorpus =
    '## 18 РЕАЛЬНЫХ ПОСТОВ ЮРИЯ:\n\n' + posts +
    '\n\n## ДОПОЛНИТЕЛЬНЫЕ МАТЕРИАЛЫ:\n\n' + knowledgeBlocks.join('\n\n');

  console.log(`Corpus size: ${fullCorpus.length} chars`);
  console.log(`Calling ${MODEL}...`);

  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  const startedAt = Date.now();
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: SYSTEM,
    messages: [{ role: 'user', content: fullCorpus }],
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  const block = r.content.find((c) => c.type === 'text');
  const raw = block && block.type === 'text' ? block.text.trim() : '';
  console.log(`Tokens: in=${r.usage.input_tokens} out=${r.usage.output_tokens}  time=${elapsed}s`);

  // strip markdown wrapper if model added one
  let jsonText = raw;
  const fence = raw.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/);
  if (fence) jsonText = fence[1]!;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error('Failed to parse JSON. Raw output:');
    console.log(raw);
    process.exit(1);
  }

  const out =
    `# Voice Analysis — Yury Eremin (v3, generated by ${MODEL} on ${new Date().toISOString()})\n\n` +
    `Corpus: 18 real Instagram posts (OCR) + knowledge/rz-funnel-content/* + voice-analysis-ye.md\n\n` +
    `## JSON\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;

  await writeFile(OUT_FILE, out, 'utf8');
  console.log(`Wrote ${OUT_FILE}`);
  await closePool();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
