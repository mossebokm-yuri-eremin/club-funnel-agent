// gc-group-polling-worker — POLLING ВМЕСТО переключателя «Периодическая проверка»
// в GC процессе 2474615.
//
// АРХИТЕКТУРА (после исследования GC PL API 2026-06-03):
//   - GC PL API НЕ управляет настройками процессов (endpoint /processes возвращает HTML 404).
//   - GC PL API НЕ принимает формат фильтров для /api/account/deals?action=export
//     (любой params в base64 даёт 908 «Должен быть передан хотя бы один фильтр»).
//   - НО: /api/account/groups?action=export работает БЕЗ params и возвращает все группы
//     с last_added_at.
//   - И: /api/account/groups/{id}/users?action=export возвращает export_id, через 2-5с
//     /api/account/exports/{export_id} даёт fields[] + items[] со всеми полями юзера
//     включая «Добавлен в группу» (timestamp) и utm_source/campaign/content.
//
// Логика воркера:
//   Каждые 5 мин для каждой группы клуба «Реализация»:
//     1. POST   /pl/api/account/groups/{group_id}/users?action=export → {export_id}
//     2. Wait 5с
//     3. GET    /pl/api/account/exports/{export_id} → {fields, items}
//     4. Парсинг fields/items → массив { user_id, email, utm_*, added_at, ... }
//     5. Фильтр added_at > last_check_at (last polling момент)
//     6. Для каждого нового члена INSERT в getcourse_raw_events с эмулированным webhook
//        payload (event=payment_succeeded, source=group_polling). request_method='POLL'.
//     7. Парсер (getcourse-parser-worker раз в 10с) подбирает их как обычные webhook
//        события → UPSERT subscriber, TG-invite, payments.
//
// State (last_check_at) хранится как timestamp последнего polled event в БД:
//   max(received_at) FROM getcourse_raw_events WHERE request_method = 'POLL'
//   AND query_params->>'_poll_origin' = 'group_polling'
//   Fallback (если нет записей) → now() - 24h (за сутки сразу не подберёт всё)
//
// Идемпотентность: order_id формируется как 'poll-{group_id}-{user_id}'. Это
// УНИКАЛЬНО для одного user в одной группе. При повторном попадании в группу
// (например после reactivation) добавляем -{added_at_ts} в order_id.

import { Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import { createRedisClient } from '../redis.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const QUEUE_NAME = 'gc_group_polling_queue';
const REPEAT_KEY = 'gc-group-polling-tick';
const REPEAT_EVERY_MS = 5 * 60 * 1000; // 5 минут

const GC_API_BASE_DEFAULT = 'https://account.getcourse.ru/pl/api';

interface GcExportResponse {
  success: boolean;
  info?: { export_id?: number } | { fields?: string[]; items?: unknown[][] };
  error_message?: string;
  error_code?: number;
}

interface PollGroupResult {
  groupId: number;
  groupLabel: string;
  totalMembers: number;
  newMembers: number;
  inserted: number;
  errors: string[];
}

export interface GcGroupPollingWorkerDeps {
  pool: Pool;
  /** Override fetch для тестов. */
  fetchImpl?: typeof fetch;
}

export interface GcGroupPollingResult {
  status: 'ok' | 'skipped' | 'error';
  groupsPolled: number;
  totalNewMembers: number;
  totalInserted: number;
  perGroup: PollGroupResult[];
  durationMs: number;
}

function getApiBase(): string {
  const acc = config.GC_ACCOUNT?.trim();
  if (acc) return `https://${acc}.getcourse.ru/pl/api`;
  return config.GC_API_BASE ?? GC_API_BASE_DEFAULT;
}

function getClubGroupIds(): { id: number; label: string }[] {
  const raw = (process.env.GC_CLUB_GROUP_IDS ?? '4665901,4808057,4707855').trim();
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const [idStr, label] = s.split(':');
      return { id: Number(idStr), label: label ?? `group_${idStr}` };
    })
    .filter((g) => Number.isInteger(g.id) && g.id > 0);
}

async function gcExportRequest(
  apiBase: string,
  apiKey: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const url = `${apiBase}${path}`;
  const body = new URLSearchParams({ key: apiKey, action: 'export' });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`gc-group-poll: ${path} HTTP ${res.status}`);
  const json = (await res.json()) as GcExportResponse;
  if (!json.success || !json.info || !('export_id' in json.info) || !json.info.export_id) {
    throw new Error(`gc-group-poll: ${path} no export_id (error_code=${json.error_code}, msg=${json.error_message})`);
  }
  return json.info.export_id;
}

async function gcExportResult(
  apiBase: string,
  apiKey: string,
  exportId: number,
  fetchImpl: typeof fetch,
): Promise<{ fields: string[]; items: unknown[][] }> {
  const url = `${apiBase}/account/exports/${exportId}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`gc-group-poll: export ${exportId} HTTP ${res.status}`);
  const json = (await res.json()) as GcExportResponse;
  if (!json.success || !json.info || !('fields' in json.info)) {
    throw new Error(`gc-group-poll: export ${exportId} not ready (msg=${json.error_message})`);
  }
  return {
    fields: json.info.fields ?? [],
    items: json.info.items ?? [],
  };
}

function buildIndexMap(fields: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  for (let i = 0; i < fields.length; i++) {
    const k = fields[i];
    if (k) idx[k] = i;
  }
  return idx;
}

function safeField(row: unknown[], idx: number | undefined): string {
  if (idx === undefined) return '';
  const v = row[idx];
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

async function getLastCheckAt(pool: Pool): Promise<Date> {
  const r = await pool.query<{ ts: Date | null }>(
    `SELECT MAX(received_at) AS ts
       FROM getcourse_raw_events
      WHERE request_method = 'POLL'
        AND query_params->>'_poll_origin' = 'group_polling'`,
  );
  const ts = r.rows[0]?.ts;
  if (ts) return new Date(ts);
  // Первая итерация — берём last 24h
  return new Date(Date.now() - 24 * 60 * 60 * 1000);
}

interface PolledMember {
  user_id: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
  telegram: string;
  utm_source: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  added_at: string; // raw timestamp string from GC (2026-06-03 12:00:34)
  group_id: string;
}

function parseMembers(
  fields: string[],
  items: unknown[][],
  groupId: number,
): PolledMember[] {
  const idx = buildIndexMap(fields);
  const out: PolledMember[] = [];
  for (const row of items) {
    if (!Array.isArray(row)) continue;
    const email = safeField(row, idx['Email']);
    const userId = safeField(row, idx['id']);
    const addedAt = safeField(row, idx['Добавлен в группу']);
    if (!email || !addedAt) continue; // без email/timestamp бесполезно
    out.push({
      user_id: userId,
      email,
      first_name: safeField(row, idx['Имя']),
      last_name: safeField(row, idx['Фамилия']),
      phone: safeField(row, idx['Телефон']),
      telegram: safeField(row, idx['телеграмм']),
      utm_source: safeField(row, idx['utm_source']),
      utm_campaign: safeField(row, idx['utm_campaign']),
      utm_content: safeField(row, idx['utm_content']),
      utm_term: safeField(row, idx['utm_term']),
      added_at: addedAt,
      group_id: String(groupId),
    });
  }
  return out;
}

/** Парсим GC datetime 2026-06-03 12:00:34 → ISO. */
function gcDateToIso(s: string): string | null {
  if (!s) return null;
  // Допустим GC отдаёт в Москве (TZ Europe/Moscow = UTC+3).
  // Не зная TZ, считаем как UTC — точность ±3h допустима для polling
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s);
  if (!m) return null;
  return `${m[1]}T${m[2]}Z`;
}

async function insertFakeWebhook(
  pool: Pool,
  member: PolledMember,
  groupLabel: string,
): Promise<boolean> {
  const orderId = `poll-${member.group_id}-${member.user_id}`;
  const paidAtIso = gcDateToIso(member.added_at);
  const fullName = `${member.first_name}_${member.last_name}`.trim();

  // Эмулируем тот же query_params что слал бы webhook
  const queryParams = {
    event: 'payment_succeeded',
    order_id: orderId,
    user_id: member.user_id,
    user_email: member.email,
    user_name: fullName,
    user_phone: member.phone,
    offer_id: '',
    offer_name: `Клуб «Реализация» (${groupLabel})`,
    amount: '5000 руб.', // стандартная цена клуба; точная сумма из реального webhook добьётся
    paid_at: member.added_at,
    utm_source: member.utm_source,
    utm_campaign: member.utm_campaign,
    utm_content: member.utm_content,
    utm_term: member.utm_term,
    telegram: member.telegram,
    _poll_origin: 'group_polling',
    _polled_group_id: member.group_id,
  };

  const r = await pool.query<{ id: string }>(
    `INSERT INTO getcourse_raw_events
       (received_at, request_method, request_path, ip_address, content_type,
        query_params, parse_status, hmac_valid)
     VALUES (COALESCE($1::timestamptz, NOW()), 'POLL', '/internal/gc-group-poll', 'gc-api-poll',
             'application/json', $2::jsonb, 'pending', NULL)
     RETURNING id`,
    [paidAtIso, JSON.stringify(queryParams)],
  );
  return r.rowCount === 1;
}

async function pollOneGroup(
  pool: Pool,
  apiBase: string,
  apiKey: string,
  group: { id: number; label: string },
  sinceUtc: Date,
  fetchImpl: typeof fetch,
): Promise<PollGroupResult> {
  const result: PollGroupResult = {
    groupId: group.id,
    groupLabel: group.label,
    totalMembers: 0,
    newMembers: 0,
    inserted: 0,
    errors: [],
  };

  try {
    const exportId = await gcExportRequest(
      apiBase,
      apiKey,
      `/account/groups/${group.id}/users`,
      fetchImpl,
    );

    // Wait for GC to prepare the export
    let exportData: { fields: string[]; items: unknown[][] } | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      // 6 attempts × 3s = up to 18s total wait
      await new Promise((r) => setTimeout(r, 3000));
      try {
        exportData = await gcExportResult(apiBase, apiKey, exportId, fetchImpl);
        break;
      } catch (err) {
        // export not ready — keep waiting
        if (attempt === 5) throw err;
      }
    }
    if (!exportData) throw new Error(`export ${exportId} never became ready`);

    const members = parseMembers(exportData.fields, exportData.items, group.id);
    result.totalMembers = members.length;

    const newOnes = members.filter((m) => {
      const iso = gcDateToIso(m.added_at);
      if (!iso) return false;
      return new Date(iso).getTime() > sinceUtc.getTime();
    });
    result.newMembers = newOnes.length;

    for (const m of newOnes) {
      try {
        const ok = await insertFakeWebhook(pool, m, group.label);
        if (ok) result.inserted++;
      } catch (err) {
        result.errors.push(`${m.email}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    result.errors.push((err as Error).message);
  }

  return result;
}

async function pollTick(deps: GcGroupPollingWorkerDeps): Promise<GcGroupPollingResult> {
  const started = Date.now();
  const apiKey = config.GC_API_KEY?.trim();
  if (!apiKey) {
    return {
      status: 'skipped',
      groupsPolled: 0,
      totalNewMembers: 0,
      totalInserted: 0,
      perGroup: [],
      durationMs: 0,
    };
  }
  const apiBase = getApiBase();
  const groups = getClubGroupIds();
  if (groups.length === 0) {
    log.warn('gc-group-polling: GC_CLUB_GROUP_IDS empty');
    return {
      status: 'skipped',
      groupsPolled: 0,
      totalNewMembers: 0,
      totalInserted: 0,
      perGroup: [],
      durationMs: 0,
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sinceUtc = await getLastCheckAt(deps.pool);
  log.info(
    { sinceUtc: sinceUtc.toISOString(), groups: groups.length },
    'gc-group-polling: tick started',
  );

  const perGroup: PollGroupResult[] = [];
  for (const g of groups) {
    const r = await pollOneGroup(deps.pool, apiBase, apiKey, g, sinceUtc, fetchImpl);
    perGroup.push(r);
    // GC ограничивает одновременные экспорты — пауза между группами
    await new Promise((res) => setTimeout(res, 2000));
  }

  const totalNew = perGroup.reduce((s, x) => s + x.newMembers, 0);
  const totalInserted = perGroup.reduce((s, x) => s + x.inserted, 0);
  const durationMs = Date.now() - started;

  log.info(
    {
      groupsPolled: perGroup.length,
      totalNewMembers: totalNew,
      totalInserted,
      durationMs,
      perGroup: perGroup.map((g) => ({
        groupId: g.groupId,
        new: g.newMembers,
        ins: g.inserted,
        errs: g.errors.length,
      })),
    },
    'gc-group-polling: tick done',
  );

  return {
    status: 'ok',
    groupsPolled: perGroup.length,
    totalNewMembers: totalNew,
    totalInserted,
    perGroup,
    durationMs,
  };
}

export function createGcGroupPollingWorker(
  deps: GcGroupPollingWorkerDeps,
): Worker<unknown, GcGroupPollingResult> {
  const worker = new Worker<unknown, GcGroupPollingResult>(
    QUEUE_NAME,
    async (_job: Job<unknown>) => pollTick(deps),
    { connection: createRedisClient(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    log.error(
      { jobId: job?.id, queue: QUEUE_NAME, err: err.message },
      'gc-group-polling-worker: job failed',
    );
  });
  return worker;
}

export async function scheduleGcGroupPollingCron(): Promise<void> {
  const { Queue } = await import('bullmq');
  const q = new Queue(QUEUE_NAME, { connection: createRedisClient() });
  try {
    await q.add(
      'gc-group-poll-tick',
      {},
      { repeat: { every: REPEAT_EVERY_MS }, jobId: REPEAT_KEY, removeOnComplete: true },
    );
    log.info(
      { everyMs: REPEAT_EVERY_MS, queue: QUEUE_NAME },
      'gc-group-polling cron: scheduled',
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'gc-group-polling cron: schedule failed (continuing)',
    );
  }
}

export { pollTick as _pollTickForTests };
