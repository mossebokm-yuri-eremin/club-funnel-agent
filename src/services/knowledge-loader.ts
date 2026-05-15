// knowledge-loader — режет MD-файлы из knowledge/rz-funnel-content/ на чанки,
// эмбеддит через OpenAI, кэширует в knowledge_embeddings, ищет релевантное
// через pgvector cosine search.
//
// Используется в content-gen как источник {{kb_excerpts}} (3-5 релевантных
// чанков по теме идеи) — поднимает качество текстов, потому что модель
// видит реальные цитаты/кейсы Юрия, а не только sysprompt-метафоры.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { createEmbedding, createEmbeddingsBatch, EMBEDDING_DIM } from '../integrations/openai.js';
import { log } from '../observability/logger.js';

export const DEFAULT_KB_DIR = 'knowledge/rz-funnel-content';
export const CHUNK_MAX_CHARS = 1500;
export const CHUNK_MIN_CHARS = 200;

export interface KbChunk {
  sourceFile: string;
  chunkIndex: number;
  text: string;
  hash: string;
}

/**
 * Режет MD на чанки. Логика:
 *   1. Сначала по `## ` секциям (H2).
 *   2. Если секция > CHUNK_MAX_CHARS — делим по абзацам (двойной перевод строки).
 *   3. Чанки < CHUNK_MIN_CHARS склеиваются со следующим.
 */
export function chunkMarkdown(md: string): string[] {
  const sections: string[] = [];
  // Режем по ## (включаем сам заголовок в чанк).
  const parts = md.split(/(^|\n)(?=## )/);
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (trimmed.length <= CHUNK_MAX_CHARS) {
      sections.push(trimmed);
      continue;
    }
    // Большая секция → режем по двойному \n.
    const paras = trimmed.split(/\n\n+/);
    let buf = '';
    for (const para of paras) {
      if ((buf + '\n\n' + para).length > CHUNK_MAX_CHARS && buf.length > 0) {
        sections.push(buf.trim());
        buf = para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
    }
    if (buf.trim()) sections.push(buf.trim());
  }
  // Склеить слишком короткие.
  const out: string[] = [];
  for (const s of sections) {
    if (out.length > 0 && (out[out.length - 1]?.length ?? 0) < CHUNK_MIN_CHARS) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${s}`;
    } else {
      out.push(s);
    }
  }
  return out.filter((c) => c.length >= 50);
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Читает все MD-файлы из директории, разбивает на чанки. */
export async function readKnowledgeChunks(
  kbDir: string = DEFAULT_KB_DIR,
): Promise<KbChunk[]> {
  let files: string[];
  try {
    files = await fs.readdir(kbDir);
  } catch (err) {
    log.warn(
      { kbDir, err: (err as Error).message },
      'knowledge-loader: directory not found, returning empty',
    );
    return [];
  }
  const chunks: KbChunk[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    if (file === 'README.md') continue;
    const fullPath = path.join(kbDir, file);
    let text: string;
    try {
      text = await fs.readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    const parts = chunkMarkdown(text);
    parts.forEach((p, i) => {
      chunks.push({
        sourceFile: file,
        chunkIndex: i,
        text: p,
        hash: sha256Hex(p),
      });
    });
  }
  return chunks;
}

/**
 * Полный refresh кэша. Сравнивает hash каждого чанка с тем что в БД —
 * заново эмбеддит только новые / изменившиеся.
 */
export async function refreshKnowledgeEmbeddings(
  pool: Pool,
  kbDir: string = DEFAULT_KB_DIR,
): Promise<{ total: number; embedded: number; skipped: number; removed: number }> {
  const chunks = await readKnowledgeChunks(kbDir);
  if (chunks.length === 0) {
    return { total: 0, embedded: 0, skipped: 0, removed: 0 };
  }

  // 1) Текущее состояние из БД.
  const existingRes = await pool.query<{ source_file: string; chunk_index: number; chunk_hash: string }>(
    `SELECT source_file, chunk_index, chunk_hash FROM knowledge_embeddings`,
  );
  const existingMap = new Map<string, string>();
  for (const r of existingRes.rows) {
    existingMap.set(`${r.source_file}#${r.chunk_index}`, r.chunk_hash);
  }

  // 2) Новые / изменившиеся.
  const toEmbed: KbChunk[] = [];
  for (const c of chunks) {
    const key = `${c.sourceFile}#${c.chunkIndex}`;
    const known = existingMap.get(key);
    if (known !== c.hash) toEmbed.push(c);
  }
  const skipped = chunks.length - toEmbed.length;

  // 3) Удалим из БД чанки которых больше нет в файлах (файл переименован/удалён,
  //    или количество секций уменьшилось).
  const currentKeys = new Set(chunks.map((c) => `${c.sourceFile}#${c.chunkIndex}`));
  let removed = 0;
  for (const [key] of existingMap) {
    if (!currentKeys.has(key)) {
      const [src, idxStr] = key.split('#');
      await pool.query(
        `DELETE FROM knowledge_embeddings WHERE source_file = $1 AND chunk_index = $2`,
        [src, Number(idxStr)],
      );
      removed++;
    }
  }

  // 4) Батч-эмбеддинг (по 32 за раз — безопасный лимит).
  let embedded = 0;
  const BATCH = 32;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const slice = toEmbed.slice(i, i + BATCH);
    const embeddings = await createEmbeddingsBatch(slice.map((c) => c.text));
    for (let j = 0; j < slice.length; j++) {
      const c = slice[j]!;
      const e = embeddings[j]!;
      const vecLiteral = `[${e.embedding.join(',')}]`;
      await pool.query(
        `INSERT INTO knowledge_embeddings (source_file, chunk_index, chunk_text, chunk_hash, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (source_file, chunk_index) DO UPDATE
            SET chunk_text = EXCLUDED.chunk_text,
                chunk_hash = EXCLUDED.chunk_hash,
                embedding  = EXCLUDED.embedding,
                updated_at = NOW()`,
        [c.sourceFile, c.chunkIndex, c.text, c.hash, vecLiteral],
      );
      embedded++;
    }
    log.info(
      { batchEnd: i + slice.length, total: toEmbed.length },
      'knowledge-loader: embedded batch',
    );
  }

  log.info({ total: chunks.length, embedded, skipped, removed }, 'knowledge-loader: refresh done');
  return { total: chunks.length, embedded, skipped, removed };
}

/**
 * Семантический поиск top-K релевантных чанков по запросу (тема идеи).
 * Возвращает текст + cosine distance.
 */
export interface KbHit {
  sourceFile: string;
  chunkIndex: number;
  text: string;
  similarity: number;
}

export async function findRelevantKbChunks(
  pool: Pool,
  query: string,
  topK = 5,
): Promise<KbHit[]> {
  if (!query.trim()) return [];
  // Проверим что в БД вообще есть эмбеддинги.
  const countRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM knowledge_embeddings WHERE embedding IS NOT NULL`,
  );
  if (Number(countRes.rows[0]?.n ?? '0') === 0) {
    return [];
  }
  let queryEmbed: number[];
  try {
    const r = await createEmbedding(query);
    queryEmbed = r.embedding;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'knowledge-loader: query embedding failed (fallback empty)',
    );
    return [];
  }
  if (queryEmbed.length !== EMBEDDING_DIM) return [];
  const vecLiteral = `[${queryEmbed.join(',')}]`;
  // Cosine distance: меньше = лучше; similarity = 1 - distance.
  const r = await pool.query<{
    source_file: string;
    chunk_index: number;
    chunk_text: string;
    distance: string;
  }>(
    `SELECT source_file, chunk_index, chunk_text,
            (embedding <=> $1::vector)::text AS distance
       FROM knowledge_embeddings
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [vecLiteral, topK],
  );
  return r.rows.map((row) => ({
    sourceFile: row.source_file,
    chunkIndex: row.chunk_index,
    text: row.chunk_text,
    similarity: 1 - Number(row.distance),
  }));
}

/** Форматирует hits как plaintext для встраивания в user-prompt content-gen. */
export function formatKbExcerpts(hits: KbHit[], maxChars = 4000): string {
  if (hits.length === 0) return '';
  const parts: string[] = ['ВЫДЕРЖКИ ИЗ БАЗЫ ЗНАНИЙ (используй как контекст, не цитируй дословно):'];
  let total = 0;
  for (const h of hits) {
    const piece = `--- ${h.sourceFile} (sim=${h.similarity.toFixed(2)}) ---\n${h.text}\n`;
    if (total + piece.length > maxChars) break;
    parts.push(piece);
    total += piece.length;
  }
  return parts.join('\n');
}
