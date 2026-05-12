// СВЯТОЙ тест (Phase 4): сквозной флоу воронки.
//   pdf_delivered → club_offered → club_purchased.
// CLAUDE.md §1 (sacred): единственный CTA — клуб. Никаких промежуточных SKU.
//
// Тест не лезет в реальную БД и ChatPlace. Делаем in-memory fake Pool
// (минимально достаточный — только нужные SQL) и spy ChatPlace.

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  sendLongreadToDirect,
  upgradeToClub,
  trackEvent,
  markPaymentResolved,
} from '../src/services/funnel.js';
import type { ChatPlaceClient } from '../src/integrations/chatplace.js';

// -- in-memory Pool --------------------------------------------------------

interface SubscriberRow {
  id: string;
  ig_username: string | null;
  status: string;
  deleted_at: string | null;
  club_paid_at: string | null;
}

interface BonusRow {
  id: string;
  title: string;
  pdf_url: string;
  pdf_gdrive_id: string;
  status: string;
  deleted_at: string | null;
}

interface FunnelEventRow {
  id: number;
  funnel_id: string | null;
  subscriber_id: string | null;
  code_word: string | null;
  event_type: string;
  source: string;
  payload: unknown;
  occurred_at: string;
  idempotency_key: string | null;
}

function makeFakePool(initial: {
  subscribers?: SubscriberRow[];
  bonuses?: BonusRow[];
}): { pool: Pool; events: FunnelEventRow[]; subscribers: SubscriberRow[] } {
  const subscribers: SubscriberRow[] = [...(initial.subscribers ?? [])];
  const bonuses: BonusRow[] = [...(initial.bonuses ?? [])];
  const events: FunnelEventRow[] = [];
  let nextEventId = 1;

  const query = vi.fn(async (sql: string, params: ReadonlyArray<unknown> = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // subscribers SELECT
    if (s.startsWith('SELECT id, ig_username, status FROM subscribers')) {
      const id = params[0] as string;
      const row = subscribers.find((x) => x.id === id && x.deleted_at === null);
      return { rows: row ? [{ id: row.id, ig_username: row.ig_username, status: row.status }] : [], rowCount: row ? 1 : 0 };
    }

    // bonus SELECT
    if (s.startsWith('SELECT id, title, pdf_url, pdf_gdrive_id, status FROM bonus_library')) {
      const id = params[0] as string;
      const b = bonuses.find((x) => x.id === id && x.deleted_at === null);
      return { rows: b ? [b] : [], rowCount: b ? 1 : 0 };
    }

    // UPDATE subscribers (markPaymentResolved — club only)
    if (s.startsWith("UPDATE subscribers SET status = 'paid'")) {
      const id = params[0] as string;
      const occurredAt = params[1] as string;
      const sub = subscribers.find((x) => x.id === id && x.deleted_at === null);
      if (sub) {
        sub.status = 'paid';
        if (!sub.club_paid_at) sub.club_paid_at = occurredAt;
      }
      return { rows: [], rowCount: sub ? 1 : 0 };
    }

    // INSERT funnel_events
    if (s.startsWith('INSERT INTO funnel_events')) {
      const [funnel_id, subscriber_id, code_word, event_type, source, payloadJson, occurred_at, idempotency_key] =
        params as readonly [
          string | null,
          string | null,
          string | null,
          string,
          string,
          string,
          string,
          string | null,
        ];
      if (idempotency_key) {
        const dup = events.find((x) => x.idempotency_key === idempotency_key);
        if (dup) return { rows: [], rowCount: 0 };
      }
      const row: FunnelEventRow = {
        id: nextEventId++,
        funnel_id,
        subscriber_id,
        code_word,
        event_type,
        source,
        payload: JSON.parse(payloadJson),
        occurred_at,
        idempotency_key,
      };
      events.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    throw new Error(`fake-pool: unexpected SQL: ${s.slice(0, 200)}`);
  });

  // pg.Pool — нужен только `.query()`.
  const pool = { query } as unknown as Pool;
  return { pool, events, subscribers };
}

function makeChatPlaceSpy(over: Partial<ChatPlaceClient> = {}): ChatPlaceClient {
  return {
    sendDirectMessage: vi.fn(async () => ({ status: 'sent' as const, message_id: 'msg-1' })),
    triggerScenario: vi.fn(async () => ({ status: 'triggered' as const, scenario_run_id: 'sr-1' })),
    getSubscriberByIgUsername: vi.fn(async (u: string) => ({ id: `cp-${u}`, ig_username: u })),
    ...over,
  };
}

// -- fixtures --------------------------------------------------------------

const SUB_ID = 'a0000000-0000-0000-0000-000000000001';
const BONUS_ID = 'b0000000-0000-0000-0000-000000000001';

function freshState(): ReturnType<typeof makeFakePool> {
  return makeFakePool({
    subscribers: [
      {
        id: SUB_ID,
        ig_username: 'anna_design',
        status: 'lead',
        deleted_at: null,
        club_paid_at: null,
      },
    ],
    bonuses: [
      {
        id: BONUS_ID,
        title: 'Чек 5000 за 8 недель',
        pdf_url: 'https://drive.google.com/file/d/abc/view',
        pdf_gdrive_id: 'abc',
        status: 'live',
        deleted_at: null,
      },
    ],
  });
}

// -- tests -----------------------------------------------------------------

describe('funnel.sendLongreadToDirect', () => {
  it('доставляет PDF через ChatPlace и пишет pdf_delivered с idempotency', async () => {
    const state = freshState();
    const chatplace = makeChatPlaceSpy();
    const result = await sendLongreadToDirect(SUB_ID, BONUS_ID, { pool: state.pool, chatplace });
    expect(result.delivered).toBe(true);
    expect(result.pdfUrl).toBe('https://drive.google.com/file/d/abc/view');
    expect(chatplace.sendDirectMessage).toHaveBeenCalledWith('cp-anna_design', expect.stringContaining('Чек 5000 за 8 недель'));
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.event_type).toBe('pdf_delivered');
    expect(state.events[0]!.idempotency_key).toBe(`pdf_delivered:${SUB_ID}:${BONUS_ID}`);

    // повторный вызов — idempotent, событий по-прежнему одно
    await sendLongreadToDirect(SUB_ID, BONUS_ID, { pool: state.pool, chatplace });
    expect(state.events).toHaveLength(1);
  });

  it('soft-deleted подписчик → not delivered, событие НЕ пишется', async () => {
    const state = freshState();
    state.subscribers[0]!.deleted_at = new Date().toISOString();
    const chatplace = makeChatPlaceSpy();
    const result = await sendLongreadToDirect(SUB_ID, BONUS_ID, { pool: state.pool, chatplace });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/subscriber/);
    expect(state.events).toHaveLength(0);
  });
});

describe('funnel.upgradeToClub', () => {
  it('строит оффер-URL с UTM, отправляет DM и пишет club_offered', async () => {
    const state = freshState();
    const chatplace = makeChatPlaceSpy();
    const r = await upgradeToClub(SUB_ID, { pool: state.pool, chatplace }, { codeWord: 'cveti_klienta' });
    expect(r.pushed).toBe(true);
    expect(r.offerUrl).toMatch(/utm_source=club_funnel/);
    expect(r.offerUrl).toMatch(/utm_campaign=cveti_klienta/);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]!.event_type).toBe('club_offered');
  });
});

describe('funnel.markPaymentResolved', () => {
  it('club: переводит подписчика в paid, ставит club_paid_at, пишет club_purchased', async () => {
    const state = freshState();
    const occurredAt = new Date('2026-05-10T12:00:00Z');
    const r = await markPaymentResolved(
      {
        subscriberId: SUB_ID,
        productKind: 'club',
        amountKopecks: 500000,
        occurredAt,
        codeWord: 'cveti_klienta',
      },
      { pool: state.pool },
    );
    expect(r.inserted).toBe(true);
    expect(state.subscribers[0]!.status).toBe('paid');
    expect(state.subscribers[0]!.club_paid_at).toBe(occurredAt.toISOString());
    expect(state.events[0]!.event_type).toBe('club_purchased');
  });

  it('отказ на float — амаунт обязан быть INTEGER (CLAUDE.md §4)', async () => {
    const state = freshState();
    await expect(
      markPaymentResolved(
        { subscriberId: SUB_ID, productKind: 'club', amountKopecks: 500.5 as unknown as number },
        { pool: state.pool },
      ),
    ).rejects.toThrow(/positive integer/);
  });

  it('идемпотентность: повторный resolve на ту же дату не плодит событий', async () => {
    const state = freshState();
    const at = new Date('2026-05-10T12:00:00Z');
    await markPaymentResolved({ subscriberId: SUB_ID, productKind: 'club', amountKopecks: 500000, occurredAt: at }, { pool: state.pool });
    await markPaymentResolved({ subscriberId: SUB_ID, productKind: 'club', amountKopecks: 500000, occurredAt: at }, { pool: state.pool });
    expect(state.events).toHaveLength(1);
  });
});

describe('funnel.trackEvent', () => {
  it('идемпотентный ключ блокирует дубликаты', async () => {
    const state = freshState();
    const deps = { pool: state.pool };
    await trackEvent(
      {
        subscriberId: SUB_ID,
        eventCode: 'ig_comment',
        source: 'instagram',
        idempotencyKey: 'igc:1',
      },
      deps,
    );
    const second = await trackEvent(
      {
        subscriberId: SUB_ID,
        eventCode: 'ig_comment',
        source: 'instagram',
        idempotencyKey: 'igc:1',
      },
      deps,
    );
    expect(second.inserted).toBe(false);
    expect(state.events).toHaveLength(1);
  });
});

describe('full flow: longread sent → club offered → club purchased', () => {
  it('фиксирует pdf_delivered, club_offered, club_purchased в правильном порядке (единственный CTA — клуб)', async () => {
    const state = freshState();
    const chatplace = makeChatPlaceSpy();
    const deps = { pool: state.pool, chatplace };

    // 1) longread → Direct
    const r1 = await sendLongreadToDirect(SUB_ID, BONUS_ID, deps);
    expect(r1.delivered).toBe(true);

    // 2) club upsell — единственный CTA
    const r2 = await upgradeToClub(SUB_ID, deps, { codeWord: 'cveti_klienta' });
    expect(r2.pushed).toBe(true);

    // 3) payment from GC webhook → club_purchased
    await markPaymentResolved(
      {
        subscriberId: SUB_ID,
        productKind: 'club',
        amountKopecks: 500000,
        codeWord: 'cveti_klienta',
      },
      deps,
    );

    const order = state.events.map((e) => e.event_type);
    expect(order).toEqual(['pdf_delivered', 'club_offered', 'club_purchased']);
    expect(state.subscribers[0]!.status).toBe('paid');
  });
});
