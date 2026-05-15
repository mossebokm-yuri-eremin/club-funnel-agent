// OpenAI integration — embeddings для семантического поиска по knowledge base.
//
// Используем text-embedding-3-small (1536 dim) — соответствует существующей колонке
// bonus_library.embedding vector(1536). Лёгкий, дешёвый, достаточный для FAQ-стиля
// поиска по нашей KB (~4000 строк, ~50 чанков).
//
// Без зависимости от openai SDK — нативный fetch.

import { config } from '../config.js';
import { log } from '../observability/logger.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  inputTokens: number;
}

interface OpenAIEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/** Возвращает embedding для одного куска текста через OpenAI. */
export async function createEmbedding(
  input: string,
  opts: { model?: string } = {},
): Promise<EmbeddingResult> {
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai: OPENAI_API_KEY not set');
  const model = opts.model ?? EMBEDDING_MODEL;
  const startedAt = Date.now();
  const res = await fetch(`${OPENAI_API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input, model }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`openai embeddings HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as OpenAIEmbedResponse;
  if (!j.data?.[0]?.embedding) {
    throw new Error('openai embeddings: no embedding in response');
  }
  log.debug(
    {
      model: j.model,
      tokens: j.usage.total_tokens,
      duration_ms: Date.now() - startedAt,
      dim: j.data[0].embedding.length,
    },
    'openai: embedding ok',
  );
  return {
    embedding: j.data[0].embedding,
    model: j.model,
    inputTokens: j.usage.prompt_tokens,
  };
}

/** Batch: эмбеддит массив строк за один запрос (до ~2048 inputs). Дешевле и быстрее. */
export async function createEmbeddingsBatch(
  inputs: string[],
  opts: { model?: string } = {},
): Promise<EmbeddingResult[]> {
  if (inputs.length === 0) return [];
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) throw new Error('openai: OPENAI_API_KEY not set');
  const model = opts.model ?? EMBEDDING_MODEL;
  const res = await fetch(`${OPENAI_API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: inputs, model }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`openai embeddings batch HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const j = (await res.json()) as OpenAIEmbedResponse;
  // Sorted by index in response
  const sorted = [...j.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => ({
    embedding: d.embedding,
    model: j.model,
    inputTokens: 0, // батч даёт суммарный prompt_tokens — не разбиваем
  }));
}

/** Косинусное сходство (для тестов / on-the-fly без pgvector). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
