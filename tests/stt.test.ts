import { describe, it, expect } from 'vitest';
import { DeepgramClient, DeepgramError } from '../src/integrations/deepgram.js';
import { transcribe } from '../src/services/stt.js';

function mkResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function mkFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

const okDeepgramBody = {
  results: {
    channels: [
      {
        alternatives: [{ transcript: 'привет это юрий', confidence: 0.93 }],
        detected_language: 'ru',
      },
    ],
    metadata: { duration: 12.5 },
  },
  metadata: { duration: 12.5, request_id: 'req-abc' },
};

describe('DeepgramClient', () => {
  it('transcribeUrl: парсит ответ, проставляет заголовки и query', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenCt = '';
    let seenBody = '';
    const client = new DeepgramClient({
      apiKey: 'dg-test-key',
      fetchImpl: mkFetch((url, init) => {
        seenUrl = url;
        const headers = init.headers as Record<string, string>;
        seenAuth = headers['Authorization'] ?? headers['authorization'] ?? '';
        seenCt = headers['Content-Type'] ?? headers['content-type'] ?? '';
        seenBody = typeof init.body === 'string' ? init.body : '';
        return mkResponse(okDeepgramBody);
      }),
    });
    const r = await client.transcribeUrl({ url: 'https://example.com/voice.ogg' });
    expect(r.text).toBe('привет это юрий');
    expect(r.confidence).toBeCloseTo(0.93, 4);
    expect(r.language).toBe('ru');
    expect(r.durationSec).toBe(12.5);
    expect(r.requestId).toBe('req-abc');

    expect(seenUrl).toContain('/v1/listen');
    expect(seenUrl).toContain('model=nova-3');
    expect(seenUrl).toContain('language=ru');
    expect(seenAuth).toBe('Token dg-test-key');
    expect(seenCt).toBe('application/json');
    expect(JSON.parse(seenBody)).toEqual({ url: 'https://example.com/voice.ogg' });
  });

  it('transcribeBuffer: ставит mimeType в Content-Type, шлёт сырое тело', async () => {
    let seenCt = '';
    let seenLen = 0;
    const buf = Buffer.from('binary-audio-bytes');
    const client = new DeepgramClient({
      apiKey: 'k',
      fetchImpl: mkFetch((_url, init) => {
        const headers = init.headers as Record<string, string>;
        seenCt = headers['Content-Type'] ?? '';
        seenLen = (init.body as Buffer).length;
        return mkResponse(okDeepgramBody);
      }),
    });
    const r = await client.transcribeBuffer({ buffer: buf, mimeType: 'audio/ogg' });
    expect(seenCt).toBe('audio/ogg');
    expect(seenLen).toBe(buf.length);
    expect(r.text).toBe('привет это юрий');
  });

  it('4xx → DeepgramError со статус-кодом', async () => {
    const client = new DeepgramClient({
      apiKey: 'k',
      fetchImpl: mkFetch(() => mkResponse('bad request', { status: 400 })),
    });
    await expect(
      client.transcribeUrl({ url: 'https://x.test/y.mp3' }),
    ).rejects.toBeInstanceOf(DeepgramError);
  });

  it('некорректный JSON-ответ → DeepgramError', async () => {
    const client = new DeepgramClient({
      apiKey: 'k',
      fetchImpl: mkFetch(() => mkResponse({ wrong: 'shape' })),
    });
    await expect(
      client.transcribeUrl({ url: 'https://x.test/y.mp3' }),
    ).rejects.toBeInstanceOf(DeepgramError);
  });
});

describe('transcribe (stt service)', () => {
  it('без клиента → status=unavailable, reason=no_api_key', async () => {
    const r = await transcribe({ kind: 'url', url: 'https://x/y' }, { client: null });
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('no_api_key');
  });

  it('успех через injected client', async () => {
    const client = new DeepgramClient({
      apiKey: 'k',
      fetchImpl: mkFetch(() => mkResponse(okDeepgramBody)),
    });
    const r = await transcribe({ kind: 'url', url: 'https://x/y.ogg' }, { client });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.text).toBe('привет это юрий');
      expect(r.language).toBe('ru');
    }
  });

  it('ошибка клиента → status=error с reason', async () => {
    const client = new DeepgramClient({
      apiKey: 'k',
      fetchImpl: mkFetch(() => mkResponse('boom', { status: 500 })),
    });
    const r = await transcribe({ kind: 'url', url: 'https://x/y.ogg' }, { client });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.statusCode).toBe(500);
    }
  });
});
