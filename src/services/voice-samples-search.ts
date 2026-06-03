// voice-samples-search — top-K реальных постов Юрия семантически близких к идее.
//
// Использует pgvector cosine similarity на yury_voice_samples.embedding (1536 dims).
// Embedding идеи получаем через GPTunnel (text-embedding-3-small, оплата ₽).

import type { Pool } from 'pg';
import { createEmbedding } from '../integrations/openai.js';
import { log } from '../observability/logger.js';

export interface VoiceSample {
  id: number;
  source_file: string;
  full_text: string;
  length_chars: number;
  similarity: number;
}

/** Top-K релевантных образцов голоса Юрия.
 * Best-effort: при падении embeddings (квота / network) возвращает первые K
 * сэмплов по id — не блокирует pipeline. */
export async function getTopVoiceSamples(
  pool: Pool,
  ideaText: string,
  k = 5,
): Promise<VoiceSample[]> {
  if (!ideaText || ideaText.trim().length < 10) return [];
  try {
    const emb = await createEmbedding(ideaText.slice(0, 4000));
    const vectorLit = '[' + emb.embedding.join(',') + ']';
    const r = await pool.query<VoiceSample>(
      `SELECT id, source_file, full_text, length_chars,
              1 - (embedding <=> $1::vector) AS similarity
         FROM yury_voice_samples
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
      [vectorLit, k],
    );
    log.debug(
      { count: r.rows.length, top_sim: r.rows[0]?.similarity ?? null },
      'voice-samples-search: top-K loaded',
    );
    return r.rows;
  } catch (err) {
    log.warn(
      { err: (err as Error).message.slice(0, 200) },
      'voice-samples-search: embeddings failed, fallback to first K by id',
    );
    const r = await pool.query<VoiceSample>(
      `SELECT id, source_file, full_text, length_chars, 0::float AS similarity
         FROM yury_voice_samples
         ORDER BY id ASC
         LIMIT $1`,
      [k],
    );
    return r.rows;
  }
}
