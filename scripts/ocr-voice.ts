// OCR 18 постов из 08-yuri-past-posts через Claude Sonnet 4.6 Vision.
// Шлёт base64 PNG → получает чистый текст → пишет в yury_voice_samples + GPTunnel embedding.

import Anthropic from '@anthropic-ai/sdk';
import { listFolderFiles, downloadFile, getFolderIdByName } from '../src/integrations/gdrive.js';
import { createEmbedding } from '../src/integrations/openai.js';
import { pool, closePool } from '../src/db/client.js';
import { config } from '../src/config.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const SYSTEM = [
  'Ты — OCR с пониманием контекста для русского текста.',
  'На входе изображение поста из Instagram (карточка с текстом).',
  'Извлеки весь текст поста как он есть — слово в слово, с переносами строк, точками, дефисами.',
  'Не добавляй ничего от себя. Не пересказывай. Не интерпретируй.',
  'Если текст разбит на несколько слайдов внутри одной картинки — собери его линейно сверху вниз через двойные переносы.',
  'Игнорируй декоративные элементы (стрелки, бейджи 01/10, watermark, handle типа @khanix.media — это служебное, не текст поста).',
  'Верни ТОЛЬКО текст поста. Без преамбулы. Без markdown-обёртки.',
].join('\n');

async function ocrOne(buf: Buffer, name: string): Promise<string> {
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    temperature: 0,
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: buf.toString('base64') } },
          { type: 'text', text: `Файл: ${name}. Извлеки текст поста.` },
        ],
      },
    ],
  });
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
}

(async () => {
  const rootId = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID!;
  const folderId = await getFolderIdByName(rootId, '08-yuri-past-posts');
  if (!folderId) throw new Error('08-yuri-past-posts folder not found');
  const items = (await listFolderFiles(folderId)).filter((f) => f.mimeType.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`found ${items.length} posts to OCR`);
  let ok = 0;
  let errors = 0;
  for (const f of items) {
    try {
      const existsRes = await pool.query<{ id: number }>(
        `SELECT id FROM yury_voice_samples WHERE source_file = $1`,
        [f.name],
      );
      if (existsRes.rows[0]) {
        console.log(`  SKIP ${f.name} (already in БД)`);
        continue;
      }
      const buf = await downloadFile(f.id);
      const text = await ocrOne(buf, f.name);
      if (text.length < 30) {
        console.log(`  WARN ${f.name}: too short text "${text.slice(0, 80)}" — skip`);
        errors += 1;
        continue;
      }
      const emb = await createEmbedding(text);
      const vectorLit = '[' + emb.embedding.join(',') + ']';
      await pool.query(
        `INSERT INTO yury_voice_samples (source_file, drive_file_id, full_text, length_chars, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (source_file) DO UPDATE SET full_text = EXCLUDED.full_text, length_chars = EXCLUDED.length_chars, embedding = EXCLUDED.embedding, updated_at = NOW()`,
        [f.name, f.id, text, text.length, vectorLit],
      );
      ok += 1;
      console.log(`  OK ${f.name} (${text.length} chars)`);
    } catch (err) {
      errors += 1;
      console.log(`  ERR ${f.name}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  console.log(`\n=== DONE ok=${ok} errors=${errors} of ${items.length} ===`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); })
  .finally(() => closePool());
