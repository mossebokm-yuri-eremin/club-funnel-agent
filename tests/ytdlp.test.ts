// Тесты для ytdlp (SPEC AC-39).
//
// Что фиксируем:
//   1. yt-dlp успех → provider='yt-dlp'.
//   2. yt-dlp падает → fallback на RapidAPI → provider='rapidapi'.
//   3. оба падают → throw (caller помечает download_status='failed').

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { downloadInstagram, type YtdlpDeps } from '../src/integrations/ytdlp.js';

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
}

function makeChild(exitCode: number, stderrChunk = ''): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (stderrChunk) child.stderr.emit('data', Buffer.from(stderrChunk));
    child.emit('close', exitCode);
  }, 5);
  return child;
}

function baseDeps(over: Partial<YtdlpDeps> = {}): YtdlpDeps {
  return {
    stat: vi.fn(async () => ({ size: 1024 })) as unknown as YtdlpDeps['stat'],
    mkdir: vi.fn(async () => undefined) as unknown as YtdlpDeps['mkdir'],
    writeFile: vi.fn(async () => undefined) as unknown as YtdlpDeps['writeFile'],
    ...over,
  };
}

describe('ytdlp downloadInstagram', () => {
  it('yt-dlp success → provider=yt-dlp', async () => {
    const spawnFn = vi.fn(() => makeChild(0)) as unknown as YtdlpDeps['spawnFn'];
    const deps = baseDeps({ spawnFn });
    const res = await downloadInstagram(
      { url: 'https://instagram.com/reel/xyz', outPath: '/tmp/test-1.mp4' },
      deps,
    );
    expect(res.provider).toBe('yt-dlp');
    expect(res.localPath).toBe('/tmp/test-1.mp4');
    expect(res.bytes).toBe(1024);
  });

  it('yt-dlp падает → fallback на RapidAPI', async () => {
    // Без RAPIDAPI_KEY в env тест провалится — мокаем fetch напрямую,
    // а сам ключ выставит config из process.env (тестовый стенд через setup-env.ts).
    const spawnFn = vi.fn(() => makeChild(1, 'yt-dlp: blocked'));
    const fetchFn = vi
      .fn()
      // 1) GET metadata → JSON с download_url
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ download_url: 'https://cdn.fake/media.mp4' }),
      })
      // 2) GET media binary → arrayBuffer
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    const stat = vi.fn(async () => ({ size: 3 }));
    const writeFile = vi.fn(async () => undefined);
    const mkdir = vi.fn(async () => undefined);

    const deps: YtdlpDeps = {
      spawnFn: spawnFn as unknown as YtdlpDeps['spawnFn'],
      fetchFn: fetchFn as unknown as YtdlpDeps['fetchFn'],
      stat: stat as unknown as YtdlpDeps['stat'],
      writeFile: writeFile as unknown as YtdlpDeps['writeFile'],
      mkdir: mkdir as unknown as YtdlpDeps['mkdir'],
    };

    const res = await downloadInstagram(
      { url: 'https://instagram.com/p/abc', outPath: '/tmp/test-2.mp4' },
      deps,
    );
    expect(res.provider).toBe('rapidapi');
    expect(res.bytes).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('оба падают → throw', async () => {
    const spawnFn = vi.fn(() => makeChild(1, 'fail'));
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'rapidapi down',
    });
    const deps: YtdlpDeps = {
      spawnFn: spawnFn as unknown as YtdlpDeps['spawnFn'],
      fetchFn: fetchFn as unknown as YtdlpDeps['fetchFn'],
      stat: vi.fn() as unknown as YtdlpDeps['stat'],
      writeFile: vi.fn() as unknown as YtdlpDeps['writeFile'],
      mkdir: vi.fn(async () => undefined) as unknown as YtdlpDeps['mkdir'],
    };
    await expect(
      downloadInstagram(
        { url: 'https://instagram.com/p/zzz', outPath: '/tmp/test-3.mp4' },
        deps,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});
