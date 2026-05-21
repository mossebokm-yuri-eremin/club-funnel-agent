// Smoke test семантического поиска по KB.
// Запуск: cd /opt/club-funnel && sudo -u club -H npx tsx /tmp/kb-smoke.ts
import { findRelevantKbChunks } from '../src/services/knowledge-loader.js';
import { pool, closePool } from '../src/db/client.js';

const QUERIES = [
  'Как Аня подняла чек до 250 тысяч',
  'портрет дизайнера интерьеров',
  'фразы которые продают',
];

async function main(): Promise<void> {
  for (const q of QUERIES) {
    console.log(`\n=== query: "${q}" ===`);
    const hits = await findRelevantKbChunks(pool, q, 3);
    if (hits.length === 0) {
      console.log('  (no hits)');
      continue;
    }
    for (const h of hits) {
      const txt = (h as { chunk_text?: string; chunkText?: string; text?: string }).chunk_text
        ?? (h as { chunkText?: string }).chunkText
        ?? (h as { text?: string }).text
        ?? '';
      const src = (h as { source_file?: string; sourceFile?: string; source?: string }).source_file
        ?? (h as { sourceFile?: string }).sourceFile
        ?? (h as { source?: string }).source
        ?? '?';
      const sim = (h as { similarity?: number; score?: number; cos?: number }).similarity
        ?? (h as { score?: number }).score
        ?? (h as { cos?: number }).cos
        ?? null;
      console.log(`  [${src}] sim=${sim?.toFixed?.(3) ?? sim} → ${txt.slice(0, 120).replace(/\n/g, ' ')}…`);
    }
  }
}

main()
  .catch((e) => {
    console.error('FAIL:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
