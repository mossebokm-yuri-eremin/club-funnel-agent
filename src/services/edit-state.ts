// edit-state — Redis-хранилище "жду инструкцию редактирования следующим сообщением".
// Если у пользователя есть active edit-state, его текстовое сообщение трактуется
// НЕ как новая идея, а как инструкция для edit-flow.
//
// TTL 30 минут — после этого state протухает (Юрий передумал / отвлёкся).

import { redis } from '../redis.js';
import { log } from '../observability/logger.js';

const TTL_SECONDS = 30 * 60;
const PREFIX = 'bot:edit_state:';

export interface EditState {
  pkg_id: string;
  started_at: number; // epoch ms
}

function key(tgUserId: number): string {
  return `${PREFIX}${tgUserId}`;
}

export async function setEditState(tgUserId: number, pkgId: string): Promise<void> {
  const state: EditState = { pkg_id: pkgId, started_at: Date.now() };
  await redis.set(key(tgUserId), JSON.stringify(state), 'EX', TTL_SECONDS);
  log.info({ tg_user_id: tgUserId, pkg_id: pkgId }, 'edit-state: set');
}

export async function getEditState(tgUserId: number): Promise<EditState | null> {
  const raw = await redis.get(key(tgUserId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EditState;
  } catch (err) {
    log.warn({ err: (err as Error).message, raw }, 'edit-state: parse failed → null');
    return null;
  }
}

export async function clearEditState(tgUserId: number): Promise<void> {
  await redis.del(key(tgUserId));
}
