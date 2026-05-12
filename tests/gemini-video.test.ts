// Тесты для gemini-video (SPEC AC-40).
//
// Что фиксируем:
//   1. Успешный анализ → transcript и visual возвращаются.
//   2. Markdown-обёртка ```json ... ``` корректно снимается.
//   3. Файл > 19 МБ → throw (требует File API).

import { describe, it, expect, vi } from 'vitest';
import { analyzeVideo, type GeminiVideoDeps } from '../src/integrations/gemini-video.js';

// GEMINI_API_KEY проставляется в tests/setup-env.ts ДО импорта config.

describe('gemini-video analyzeVideo', () => {
  it('успешный JSON → transcript + visual', async () => {
    const fakeJson = {
      transcript: 'Здравствуйте, я Юрий, и сегодня я хочу рассказать…',
      visual: {
        shots: ['крупный план', 'средний план'],
        emotions: ['сосредоточенность'],
        onscreen_text: ['Реализация'],
        pacing: 'размеренный',
      },
    };
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(fakeJson) }] } }],
      }),
    });
    const readFile = vi.fn(async () => Buffer.from('fake-mp4-bytes'));
    const deps: GeminiVideoDeps = {
      fetchFn: fetchFn as unknown as GeminiVideoDeps['fetchFn'],
      readFile: readFile as unknown as GeminiVideoDeps['readFile'],
    };
    const res = await analyzeVideo(
      { localPath: '/tmp/fake.mp4', assetKind: 'reel' },
      deps,
    );
    expect(res.transcript).toContain('Юрий');
    expect(res.visual.shots).toHaveLength(2);
    expect(res.visual.onscreen_text[0]).toBe('Реализация');
  });

  it('markdown-обёртка ```json``` снимается', async () => {
    const fakeJson = {
      transcript: 'ok',
      visual: { shots: [], emotions: [], onscreen_text: [], pacing: '' },
    };
    const wrapped = '```json\n' + JSON.stringify(fakeJson) + '\n```';
    const fetchFn = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: wrapped }] } }],
      }),
    });
    const readFile = vi.fn(async () => Buffer.from('x'));
    const deps: GeminiVideoDeps = {
      fetchFn: fetchFn as unknown as GeminiVideoDeps['fetchFn'],
      readFile: readFile as unknown as GeminiVideoDeps['readFile'],
    };
    const res = await analyzeVideo(
      { localPath: '/tmp/fake.mp4', assetKind: 'reel' },
      deps,
    );
    expect(res.transcript).toBe('ok');
  });

  it('файл > 19 MB → throw (нужен File API)', async () => {
    const huge = Buffer.alloc(20 * 1024 * 1024);
    const readFile = vi.fn(async () => huge);
    const deps: GeminiVideoDeps = {
      readFile: readFile as unknown as GeminiVideoDeps['readFile'],
    };
    await expect(
      analyzeVideo({ localPath: '/tmp/huge.mp4', assetKind: 'reel' }, deps),
    ).rejects.toThrow(/File API/);
  });
});
