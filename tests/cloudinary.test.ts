// SACRED-tests для Cloudinary uploader (SPEC AC-21).
//
// Что фиксируем:
//   1. Happy-path: успешный upload возвращает source='cloudinary' и Cloudinary URL.
//   2. Timeout: при timeoutMs=50 и долгом fake uploader (>500ms) — fallback на local
//      с source='local' и URL через APP_PUBLIC_BASE_URL/cdn/.

import { describe, it, expect, vi } from 'vitest';
import { uploadCarouselImage } from '../src/integrations/cloudinary.js';

const IDEA = '33333333-3333-3333-3333-333333333333';

function makeFakeUploader(behavior: 'ok' | 'slow' | 'error'): {
  upload_stream: ReturnType<typeof vi.fn>;
} {
  return {
    upload_stream: vi.fn((opts: { public_id: string; folder: string }, cb: (err: unknown, res?: unknown) => void) => {
      // Возвращаем "поток" с методом end, который вызывает cb.
      return {
        end: (_buf: Buffer): void => {
          if (behavior === 'ok') {
            setTimeout(() => {
              cb(null, {
                public_id: `${opts.folder}/${opts.public_id}`,
                secure_url: `https://res.cloudinary.com/test/image/upload/${opts.folder}/${opts.public_id}.jpg`,
              });
            }, 5);
          } else if (behavior === 'slow') {
            // Симулируем долгий upload — больше чем timeoutMs.
            setTimeout(() => {
              cb(null, { public_id: 'never-fires', secure_url: 'never' });
            }, 500);
          } else {
            setTimeout(() => cb(new Error('cloudinary fake error')), 5);
          }
        },
      };
    }),
  };
}

describe('cloudinary uploader', () => {
  it('happy-path: успешный upload → source=cloudinary', async () => {
    const fakeUploader = makeFakeUploader('ok');
    const res = await uploadCarouselImage(
      {
        jpg: Buffer.from('jpg-bytes'),
        ideaId: IDEA,
        slideIndex: 1,
        artifact: 'carousel',
      },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uploader: fakeUploader as any,
        timeoutMs: 1000,
      },
    );
    expect(res.source).toBe('cloudinary');
    expect(res.url).toMatch(/^https:\/\/res\.cloudinary\.com\/test\//);
    expect(res.url).toContain('carousel-01');
  });

  it('timeout → fallback на local с source=local', async () => {
    const fakeUploader = makeFakeUploader('slow');
    const writes: Array<{ path: string; bytes: number }> = [];
    const fakeWriteFile = vi.fn(async (p: string, buf: Buffer) => {
      writes.push({ path: p, bytes: buf.length });
    });
    const fakeMkdir = vi.fn(async () => undefined);

    const res = await uploadCarouselImage(
      {
        jpg: Buffer.from('jpg-bytes-7'),
        ideaId: IDEA,
        slideIndex: 2,
        artifact: 'carousel',
      },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uploader: fakeUploader as any,
        timeoutMs: 50,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writeFile: fakeWriteFile as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkdir: fakeMkdir as any,
      },
    );
    expect(res.source).toBe('local');
    expect(res.url).toMatch(/\/cdn\//);
    expect(res.url).toContain('carousel-02.jpg');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.bytes).toBe(7);
  });

  it('error от Cloudinary → fallback на local', async () => {
    const fakeUploader = makeFakeUploader('error');
    const fakeWriteFile = vi.fn(async () => undefined);
    const fakeMkdir = vi.fn(async () => undefined);

    const res = await uploadCarouselImage(
      {
        jpg: Buffer.from('x'),
        ideaId: IDEA,
        slideIndex: 3,
        artifact: 'carousel',
      },
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        uploader: fakeUploader as any,
        timeoutMs: 1000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writeFile: fakeWriteFile as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkdir: fakeMkdir as any,
      },
    );
    expect(res.source).toBe('local');
    expect(res.url).toContain('carousel-03.jpg');
  });
});
