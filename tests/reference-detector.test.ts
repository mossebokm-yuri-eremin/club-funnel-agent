import { describe, it, expect } from 'vitest';
import {
  detectReference,
  IG_BRIDGE_BOTS,
  type DetectableMessage,
} from '../src/services/reference-detector.js';

describe('detectReference — rule (a) IG URL', () => {
  it('распознаёт https URL Reels в plain text', () => {
    const m: DetectableMessage = {
      text: 'смотри что нашёл https://www.instagram.com/reel/Cabc123XYZ/?utm_source=ig',
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_url');
    expect(r.mediaUrl).toContain('instagram.com/reel/Cabc123XYZ');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('распознаёт URL поста /p/ в caption', () => {
    const m: DetectableMessage = {
      caption: 'instagram.com/p/CshortPost1/',
      photo: [{}],
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_url');
    expect(r.mediaUrl).toContain('instagram.com/p/CshortPost1');
  });

  it('распознаёт через entities.text_link (URL не в тексте)', () => {
    const text = 'кликни сюда';
    const m: DetectableMessage = {
      text,
      entities: [
        {
          type: 'text_link',
          offset: 7,
          length: 4,
          url: 'https://instagram.com/reel/Cabc999/',
        },
      ],
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_url');
    expect(r.mediaUrl).toContain('instagram.com/reel/Cabc999');
  });

  it('распознаёт через entities.url (URL в тексте)', () => {
    const text = 'тут: https://instagram.com/reels/Cqwerty/';
    const m: DetectableMessage = {
      text,
      entities: [
        { type: 'url', offset: 5, length: text.length - 5 },
      ],
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_url');
  });

  it('игнорирует НЕ-IG URL (tiktok)', () => {
    const m: DetectableMessage = { text: 'https://tiktok.com/@x/video/123' };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
    expect(r.source).toBeNull();
  });
});

describe('detectReference — rule (b) forward_origin IG channel', () => {
  it('forward от канала с username включающим "insta"', () => {
    const m: DetectableMessage = {
      video: { duration: 30 },
      forward_origin: {
        type: 'channel',
        chat: { id: -100123, username: 'instagram_bridge_ru', title: 'IG Bridge RU' },
      },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('forward_ig_channel');
  });

  it('forward от канала с другим username — НЕ референс через это правило', () => {
    const m: DetectableMessage = {
      text: 'обычный пост из канала',
      forward_origin: {
        type: 'channel',
        chat: { username: 'some_random_channel' },
      },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
  });

  it('forward от user (не канал) — не падает, не срабатывает', () => {
    const m: DetectableMessage = {
      text: 'пересланное от друга',
      forward_origin: { type: 'user', sender_user: { id: 42, username: 'friend' } },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
  });
});

describe('detectReference — rule (c) media forward без caption', () => {
  it('видео переслано без caption → референс', () => {
    const m: DetectableMessage = {
      video: { duration: 28 },
      forward_origin: { type: 'hidden_user', sender_user_name: 'Аноним' },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('media_forward_no_caption');
  });

  it('фото переслано без caption → референс', () => {
    const m: DetectableMessage = {
      photo: [{}, {}],
      forward_origin: { type: 'hidden_user', sender_user_name: 'Аноним' },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('media_forward_no_caption');
  });

  it('видео переслано С caption (но без IG-сигналов) → НЕ референс через (c)', () => {
    const m: DetectableMessage = {
      video: { duration: 28 },
      caption: 'мой комментарий к видео',
      forward_origin: { type: 'hidden_user', sender_user_name: 'Аноним' },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
  });

  it('видео БЕЗ forward_origin (просто загруженное) → не референс', () => {
    const m: DetectableMessage = { video: { duration: 28 } };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
  });

  it('document с mime_type video/mp4 + forward без caption → референс', () => {
    const m: DetectableMessage = {
      document: { mime_type: 'video/mp4' },
      forward_origin: { type: 'hidden_user', sender_user_name: 'X' },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('media_forward_no_caption');
  });
});

describe('detectReference — rule (d) IG-bridge bot', () => {
  it('via_bot из дефолтного списка bridge ботов', () => {
    const bot = IG_BRIDGE_BOTS[0];
    expect(bot).toBeTruthy();
    const m: DetectableMessage = {
      text: 'кто-то прислал через мост',
      via_bot: { username: bot! },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_bridge_bot');
  });

  it('extraBridgeBots — дополнительный bot опознаётся', () => {
    const m: DetectableMessage = {
      text: 'tap',
      via_bot: { username: 'my_custom_ig_bot' },
    };
    const r = detectReference(m, { extraBridgeBots: ['my_custom_ig_bot'] });
    expect(r.isReference).toBe(true);
    expect(r.source).toBe('ig_bridge_bot');
  });

  it('via_bot с неизвестным username → не референс', () => {
    const m: DetectableMessage = {
      text: 'tap',
      via_bot: { username: 'totally_random_bot' },
    };
    const r = detectReference(m);
    expect(r.isReference).toBe(false);
  });
});

describe('detectReference — edge cases и приоритеты', () => {
  it('пустое сообщение → не референс', () => {
    const r = detectReference({});
    expect(r.isReference).toBe(false);
    expect(r.source).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('обычный текст без признаков → не референс', () => {
    const r = detectReference({ text: 'привет, как дела?' });
    expect(r.isReference).toBe(false);
  });

  it('URL имеет приоритет над forward', () => {
    const m: DetectableMessage = {
      text: 'смотри https://instagram.com/reel/Cabc/',
      forward_origin: { type: 'channel', chat: { username: 'instagram_clips' } },
    };
    const r = detectReference(m);
    expect(r.source).toBe('ig_url');
  });

  it('bridge_bot приоритетнее, чем media_forward (когда нет URL)', () => {
    const m: DetectableMessage = {
      video: { duration: 30 },
      forward_origin: { type: 'hidden_user', sender_user_name: 'X' },
      via_bot: { username: IG_BRIDGE_BOTS[0]! },
    };
    const r = detectReference(m);
    expect(r.source).toBe('ig_bridge_bot');
  });

  it('captionText возвращается, когда есть caption', () => {
    const r = detectReference({
      caption: 'это IG: https://instagram.com/reel/Cabc/',
      video: {},
    });
    expect(r.captionText).toBe('это IG: https://instagram.com/reel/Cabc/');
  });

  it('IG_URL_RE не матчит instagram.com/explore/ (не reel/p/tv)', () => {
    const r = detectReference({ text: 'https://instagram.com/explore/tags/x/' });
    expect(r.isReference).toBe(false);
  });
});
