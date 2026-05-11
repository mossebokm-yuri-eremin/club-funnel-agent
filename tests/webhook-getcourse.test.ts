import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  getCourseWebhookPlugin,
  verifyHmac,
  eventIdFromPayload,
  type IdempotencyStore,
  type GetCourseDealPayload,
} from '../src/webhooks/getcourse.js';

const SECRET = 'test-secret-1234567890';

function sign(rawBody: Buffer | string, secret: string = SECRET): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

class InMemoryStore implements IdempotencyStore {
  private map = new Map<string, number>();
  acquire(key: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const exp = this.map.get(key);
    if (exp && exp > now) return Promise.resolve(false);
    this.map.set(key, now + ttlSeconds * 1000);
    return Promise.resolve(true);
  }
  size(): number {
    return this.map.size;
  }
}

interface BuildAppArgs {
  idempotency: IdempotencyStore;
  onPayload?: (p: GetCourseDealPayload, ctx: { eventId: string; raw: Buffer }) => Promise<void> | void;
  secret?: string;
}

async function buildApp({ idempotency, onPayload, secret = SECRET }: BuildAppArgs): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const opts: Parameters<typeof getCourseWebhookPlugin>[1] = { secret, idempotency };
  if (onPayload) opts.onPayload = onPayload;
  await app.register(getCourseWebhookPlugin, opts);
  await app.ready();
  return app;
}

const samplePayload: GetCourseDealPayload = {
  action: 'deal.success',
  deal: {
    id: '1234567',
    status: 'Оплачен',
    user: { email: 'test@example.com', phone: '+79991112233', first_name: 'Анна' },
    offer_id: '789',
    amount: '5000.00',
    currency: 'RUB',
    utm: { utm_source: 'club_funnel', utm_campaign: 'cveti_klienta' },
    paid_at: '2026-05-10T12:34:56+03:00',
  },
  timestamp: 1736512496,
};

describe('verifyHmac (unit)', () => {
  it('валидная подпись → true', () => {
    const body = Buffer.from(JSON.stringify(samplePayload));
    expect(verifyHmac(body, sign(body), SECRET)).toBe(true);
  });

  it('пустая подпись → false', () => {
    expect(verifyHmac(Buffer.from('{}'), undefined, SECRET)).toBe(false);
    expect(verifyHmac(Buffer.from('{}'), '', SECRET)).toBe(false);
  });

  it('подпись от другого секрета → false', () => {
    const body = Buffer.from('{"x":1}');
    expect(verifyHmac(body, sign(body, 'other-secret'), SECRET)).toBe(false);
  });

  it('подпись короче ожидаемой → false (без timingSafeEqual throw)', () => {
    const body = Buffer.from('{"x":1}');
    expect(verifyHmac(body, 'deadbeef', SECRET)).toBe(false);
  });

  it('case-insensitive по hex', () => {
    const body = Buffer.from('{"x":1}');
    const upper = sign(body).toUpperCase();
    expect(verifyHmac(body, upper, SECRET)).toBe(true);
  });
});

describe('eventIdFromPayload', () => {
  it('строит ключ из action+deal.id+timestamp', () => {
    expect(eventIdFromPayload(samplePayload)).toBe('deal.success:1234567:1736512496');
  });
  it('fallback на хеш, если нет deal.id', () => {
    const id = eventIdFromPayload({ action: 'deal.success' });
    expect(id.startsWith('deal.success:noid:')).toBe(true);
  });
});

describe('POST /webhook/getcourse (integration)', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('невалидный HMAC → 401, обработчик не вызывается', async () => {
    let called = 0;
    const app = await buildApp({
      idempotency: store,
      onPayload: () => {
        called++;
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook/getcourse',
      headers: { 'content-type': 'application/json', 'x-gc-signature': 'deadbeef' },
      payload: JSON.stringify(samplePayload),
    });

    expect(res.statusCode).toBe(401);
    expect(called).toBe(0);
    expect(store.size()).toBe(0);
    await app.close();
  });

  it('отсутствует заголовок подписи → 401', async () => {
    const app = await buildApp({ idempotency: store });
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/getcourse',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(samplePayload),
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('валидный HMAC → 200, processed=true, onPayload вызван 1 раз', async () => {
    let called = 0;
    let seenEventId = '';
    const app = await buildApp({
      idempotency: store,
      onPayload: (p, ctx) => {
        called++;
        seenEventId = ctx.eventId;
        expect(p.deal?.id).toBe('1234567');
      },
    });

    const raw = JSON.stringify(samplePayload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/getcourse',
      headers: { 'content-type': 'application/json', 'x-gc-signature': sign(raw) },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: true, eventId: 'deal.success:1234567:1736512496' });
    expect(called).toBe(1);
    expect(seenEventId).toBe('deal.success:1234567:1736512496');
    await app.close();
  });

  it('идемпотентность: повторный валидный вызов → 200, processed=false, обработчик НЕ вызывается', async () => {
    let called = 0;
    const app = await buildApp({
      idempotency: store,
      onPayload: () => {
        called++;
      },
    });

    const raw = JSON.stringify(samplePayload);
    const headers = { 'content-type': 'application/json', 'x-gc-signature': sign(raw) };

    const first = await app.inject({ method: 'POST', url: '/webhook/getcourse', headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: '/webhook/getcourse', headers, payload: raw });

    expect(first.statusCode).toBe(200);
    expect(first.json().processed).toBe(true);
    expect(second.statusCode).toBe(200);
    expect(second.json().processed).toBe(false);
    expect(called).toBe(1);
    await app.close();
  });

  it('raw body доступен в onPayload для re-verify', async () => {
    let seenRaw: Buffer | null = null;
    const app = await buildApp({
      idempotency: store,
      onPayload: (_p, ctx) => {
        seenRaw = ctx.raw;
      },
    });

    const raw = JSON.stringify(samplePayload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/getcourse',
      headers: { 'content-type': 'application/json', 'x-gc-signature': sign(raw) },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(seenRaw).not.toBeNull();
    // Re-verify: подпись должна валидироваться от того же буфера
    expect(verifyHmac(seenRaw as unknown as Buffer, sign(raw), SECRET)).toBe(true);
    await app.close();
  });

  it('handler exception НЕ роняет ответ (но событие считается обработанным)', async () => {
    const app = await buildApp({
      idempotency: store,
      onPayload: () => {
        throw new Error('boom');
      },
    });

    const raw = JSON.stringify(samplePayload);
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/getcourse',
      headers: { 'content-type': 'application/json', 'x-gc-signature': sign(raw) },
      payload: raw,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(true);
    await app.close();
  });

  it('payload без deal.id → fallback eventId, повтор всё ещё идемпотентен', async () => {
    const payload = { action: 'deal.success' };
    const raw = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'x-gc-signature': sign(raw) };

    let called = 0;
    const app = await buildApp({
      idempotency: store,
      onPayload: () => {
        called++;
      },
    });

    const first = await app.inject({ method: 'POST', url: '/webhook/getcourse', headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: '/webhook/getcourse', headers, payload: raw });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(called).toBe(1);
    await app.close();
  });
});
