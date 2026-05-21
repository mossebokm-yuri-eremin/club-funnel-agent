// Embeddings integration — text-embedding-3-small (1536 dim).
//
// Default provider — GPTunnel (российский агрегатор, оплата ₽, OpenAI-совместимый):
//   POST https://gptunnel.ru/v1/embeddings
//   Authorization: <token>           ← БЕЗ префикса 'Bearer'
//   body: { model, input }
//   response: { data:[{embedding}], usage:{ prompt_tokens, total_cost, ... } }
//
// Fallback (опц., EMBEDDING_OPENAI_FALLBACK=true) — прямой OpenAI:
//   POST https://api.openai.com/v1/embeddings
//   Authorization: Bearer <token>
//
// Файл оставлен с именем openai.ts и теми же exported-функциями
// (createEmbedding, createEmbeddingsBatch), чтобы не ломать вызовы
// knowledge-loader / refresh-kb. Имя файла = legacy; провайдер
// выбирается через config.EMBEDDING_PROVIDER.

import { config } from '../config.js';
import { log } from '../observability/logger.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

const OPENAI_API_BASE = 'https://api.openai.com/v1';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  inputTokens: number;
  /** Стоимость в рублях (GPTunnel вернёт; для прямого OpenAI = 0). */
  costRub?: number;
  /** Провайдер, который реально отработал ('gptunnel' | 'openai'). */
  providerUsed?: 'gptunnel' | 'openai';
}

interface OpenAICompatEmbedResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
    total_cost?: number;
    prompt_cost?: number;
  };
}

type Provider = 'gptunnel' | 'openai';

function pickProviderChain(): Provider[] {
  const primary: Provider = config.EMBEDDING_PROVIDER === 'openai' ? 'openai' : 'gptunnel';
  const chain: Provider[] = [primary];
  if (primary === 'gptunnel' && config.EMBEDDING_OPENAI_FALLBACK && config.OPENAI_API_KEY) {
    chain.push('openai');
  }
  return chain;
}

function providerEndpoint(p: Provider): string {
  if (p === 'gptunnel') return `${config.GPTUNNEL_EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`;
  return `${OPENAI_API_BASE}/embeddings`;
}

function providerAuthHeader(p: Provider): string | null {
  if (p === 'gptunnel') {
    return config.GPTUNNEL_API_KEY ? config.GPTUNNEL_API_KEY : null;
  }
  return config.OPENAI_API_KEY ? `Bearer ${config.OPENAI_API_KEY}` : null;
}

function providerModel(p: Provider, requested?: string): string {
  if (requested) return requested;
  if (p === 'gptunnel') return config.GPTUNNEL_EMBEDDING_MODEL;
  return EMBEDDING_MODEL;
}

async function callEmbed(
  provider: Provider,
  input: string | string[],
  model: string,
): Promise<OpenAICompatEmbedResponse> {
  const auth = providerAuthHeader(provider);
  if (!auth) {
    throw new Error(
      provider === 'gptunnel'
        ? 'embeddings: GPTUNNEL_API_KEY not set'
        : 'embeddings: OPENAI_API_KEY not set',
    );
  }
  const url = providerEndpoint(provider);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth,
    },
    body: JSON.stringify({ input, model }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(
      `embeddings[${provider}] HTTP ${res.status}: ${t.slice(0, 200)}`,
    );
  }
  return (await res.json()) as OpenAICompatEmbedResponse;
}

async function withFallback<T>(
  fn: (provider: Provider) => Promise<T>,
): Promise<{ data: T; providerUsed: Provider }> {
  const chain = pickProviderChain();
  let lastErr: Error | null = null;
  for (const p of chain) {
    try {
      const data = await fn(p);
      return { data, providerUsed: p };
    } catch (err) {
      lastErr = err as Error;
      log.warn(
        { provider: p, err: lastErr.message.slice(0, 200) },
        'embeddings: provider failed, trying next',
      );
    }
  }
  throw lastErr ?? new Error('embeddings: all providers failed');
}

/** Возвращает embedding для одного куска текста. */
export async function createEmbedding(
  input: string,
  opts: { model?: string } = {},
): Promise<EmbeddingResult> {
  const startedAt = Date.now();
  const { data: j, providerUsed } = await withFallback((provider) =>
    callEmbed(provider, input, providerModel(provider, opts.model)),
  );
  if (!j.data?.[0]?.embedding) {
    throw new Error(`embeddings[${providerUsed}]: no embedding in response`);
  }
  const result: EmbeddingResult = {
    embedding: j.data[0].embedding,
    model: j.model,
    inputTokens: j.usage.prompt_tokens,
    providerUsed,
  };
  if (typeof j.usage.total_cost === 'number') result.costRub = j.usage.total_cost;
  log.debug(
    {
      provider: providerUsed,
      model: j.model,
      tokens: j.usage.total_tokens,
      cost_rub: j.usage.total_cost,
      duration_ms: Date.now() - startedAt,
      dim: j.data[0].embedding.length,
    },
    'embeddings: ok',
  );
  return result;
}

/** Batch: эмбеддит массив строк за один запрос. */
export async function createEmbeddingsBatch(
  inputs: string[],
  opts: { model?: string } = {},
): Promise<EmbeddingResult[]> {
  if (inputs.length === 0) return [];
  const startedAt = Date.now();
  const { data: j, providerUsed } = await withFallback((provider) =>
    callEmbed(provider, inputs, providerModel(provider, opts.model)),
  );
  const sorted = [...j.data].sort((a, b) => a.index - b.index);
  log.info(
    {
      provider: providerUsed,
      model: j.model,
      count: sorted.length,
      tokens: j.usage.total_tokens,
      cost_rub: j.usage.total_cost,
      duration_ms: Date.now() - startedAt,
    },
    'embeddings: batch ok',
  );
  return sorted.map((d) => {
    const r: EmbeddingResult = {
      embedding: d.embedding,
      model: j.model,
      inputTokens: 0,
      providerUsed,
    };
    if (typeof j.usage.total_cost === 'number') r.costRub = j.usage.total_cost;
    return r;
  });
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
