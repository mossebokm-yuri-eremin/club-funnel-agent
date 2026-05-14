// longread-runner — высокоуровневый запуск longread-factory по ideaId.
// Используется после approve-outline в TG-боте (AC-16).

import type { Pool } from 'pg';
import { z } from 'zod';
import { generateLongread } from './longread-factory.js';
import { log } from '../observability/logger.js';

const IdeaRowSchema = z.object({
  id: z.string(),
  pain_tag: z.string(),
  longread_title: z.string(),
  longread_code_word: z.string(),
  longread_outline: z.array(z.object({ h2: z.string(), summary: z.string() })),
});

export async function runLongreadDraft(pool: Pool, ideaId: string): Promise<void> {
  const r = await pool.query(
    `SELECT id, pain_tag, longread_title, longread_code_word, longread_outline
       FROM ideas WHERE id = $1`,
    [ideaId],
  );
  const parsed = IdeaRowSchema.safeParse(r.rows[0]);
  if (!parsed.success) {
    throw new Error(`longread-runner: idea ${ideaId} not ready (missing outline/title/code_word)`);
  }
  const row = parsed.data;
  log.info({ ideaId, wordsExpected: '1500-2500' }, 'longread-runner: generation started');
  const result = await generateLongread(
    {
      ideaId: row.id,
      title: row.longread_title,
      outline: row.longread_outline,
      painTag: row.pain_tag,
      codeWord: row.longread_code_word,
    },
    { pool },
  );
  await pool.query(
    `UPDATE ideas SET longread_draft_md = $2, updated_at = NOW() WHERE id = $1`,
    [ideaId, result.bodyMd],
  );
  log.info(
    { ideaId, wordCount: result.wordCount, attempts: result.attempts, escalated: result.escalated },
    'longread-runner: draft saved',
  );
}
