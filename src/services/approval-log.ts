// approval-log — централизованная запись в approval_log (AC-24 SPEC).
//
// approval_log — вход для retrain (AC-35: winning_patterns подбираются по
// одобренным пакетам). Если эту запись не делать — retrain просто не работает.
//
// Schema (migration 001):
//   idea_id       UUID NOT NULL
//   artifact_type TEXT NOT NULL   — 'content_package' | 'longread_outline' | 'longread_draft'
//   voice_code    TEXT optional   — 'YE' | 'RZ'
//   action        TEXT CHECK IN ('approved','rejected','commented','cancelled')
//   comment       TEXT optional
//   attempt_no    INTEGER default 1
//   acted_at      TIMESTAMPTZ default NOW()

import type { Pool } from 'pg';
import { log } from '../observability/logger.js';

export type ApprovalAction = 'approved' | 'rejected' | 'commented' | 'cancelled';
export type ArtifactType = 'content_package' | 'longread_outline' | 'longread_draft';
export type VoiceCode = 'YE' | 'RZ';

export interface ApprovalLogInput {
  ideaId: string;
  artifactType: ArtifactType;
  action: ApprovalAction;
  voiceCode?: VoiceCode;
  comment?: string;
  attemptNo?: number;
}

/**
 * INSERT в approval_log. Best-effort: ошибка логируется, но не пробрасывается
 * наверх — callback handler должен продолжить работу даже если запись не удалась.
 */
export async function recordApproval(
  pool: Pool,
  input: ApprovalLogInput,
): Promise<{ id: number } | null> {
  try {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO approval_log
         (idea_id, artifact_type, voice_code, action, comment, attempt_no)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.ideaId,
        input.artifactType,
        input.voiceCode ?? null,
        input.action,
        input.comment ?? null,
        input.attemptNo ?? 1,
      ],
    );
    log.info(
      {
        ideaId: input.ideaId,
        artifactType: input.artifactType,
        action: input.action,
      },
      'approval-log: recorded',
    );
    return { id: r.rows[0]!.id };
  } catch (err) {
    log.error(
      {
        err: (err as Error).message,
        ideaId: input.ideaId,
        artifactType: input.artifactType,
        action: input.action,
      },
      'approval-log: insert failed (non-fatal)',
    );
    return null;
  }
}

/** Достаёт idea_id по content_package_id (один SQL). */
export async function ideaIdForPackage(pool: Pool, pkgId: string): Promise<string | null> {
  try {
    const r = await pool.query<{ idea_id: string }>(
      `SELECT idea_id FROM content_packages WHERE id = $1`,
      [pkgId],
    );
    return r.rows[0]?.idea_id ?? null;
  } catch {
    return null;
  }
}
