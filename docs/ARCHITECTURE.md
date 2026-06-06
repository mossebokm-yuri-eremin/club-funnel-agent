# club-funnel-agent — Архитектура

## Производственный pipeline

```
[1] Юрий записывает голосовое в @Realizacia_marketing_bot
       │
       │ Telegram POST /webhook/telegram
       ▼
[2] handlers.ts (allowlist: YE_TG_USER_ID + YE_TG_USER_IDS CSV)
       │ enqueue
       ▼
[3] audio_queue (BullMQ/Redis)
       │
       ▼
[4] stt-worker (Deepgram nova-3 ru)
       │ raw_transcript
       ▼
[5] idea-builder (twin-ye.v1 — TWIN_YE_SYSTEM_PROMPT)
       │ idea.summary, pain_tag, angle_transcript
       ▼
[6] strategy-chooser (A: PDF-лонгрид / B: быстрая карусель / C: короткий PDF)
       │
       ▼
[7] content_queue → content-worker → content-gen.ts
       │
       │   ┌─ buildTwinYePrompt(kind='reel')      → ContentKind=reel
       │   ├─ buildTwinYePrompt(kind='tg_post')   → ContentKind=tg_post
       │   ├─ buildCarouselTextPrompt              → 10 слайдов
       │   └─ buildTwinRzPrompt(kind='tg_post')   → Виктория RZ
       │
       │   Each → callAnthropic(claude-sonnet-4-6, temp=0.85, maxTokens=4000)
       │   Each → validateVoiceV3 (with HistoryContext: last7d + last3reels)
       │
       │   Retry до 3 раз при violations. После 3 — escalated=true, save anyway.
       ▼
[8] content_packages INSERT (reel_caption, tg_post, carousel_slides, validator_report)
       │
       ▼
[9] visual_queue → carousel-worker → carousel-renderer
       │
       │  Если CAROUSEL_USE_TEMPLATES=true:
       │     SVG-шаблоны из GDrive → Sharp overlay → /var/www/cdn/{idea_id}/carousel-NN.jpg
       │  Иначе:
       │     Seedream-4 (GPTunnel 8 ₽/img) style-transfer → Sharp 1080×1350 → watermark
       ▼
[10] approval-notifier → Telegram (Юрию):
       • 🎯 РИЛС
       • 📝 ПОСТ TG
       • 📝 ПОСТ ОТ ВИКТОРИИ
       • 📸 Альбом 10 слайдов
       • Кнопки: ✅ Одобрить / 🔄 Перегенерировать / ✏️ Правка / ✖ Отклонить
       │
       │ Юрий жмёт ✅
       ▼
[11] callback cp:approve:UUID → activateFunnelOnApprove (funnel-activator.ts)
       │
       │   1. generateUniqueCodeWord (на основе pain_tag + bonus)
       │   2. INSERT funnels (idea_id, code_word, strategy, status='live')
       │   3. ChatPlace API → создаём scenario:
       │        triggers: получение code_word в Direct
       │        steps:    A/C → send PDF лонгрида; B → ссылка на TG warmup
       │   4. UPDATE funnels SET chatplace_automation_id
       │   5. funnel_events.event_type='longread_offered' (или 'club_offered')
       ▼
[12] generateIgCaption (Sonnet 4.6) → подпись с органичной интеграцией code_word
       │
       ▼
[13] writeCarouselBrief → /var/www/cdn/briefs/{pkgId}.md (nginx alias /cdn/)
       │
       ▼
[14] sendMessageRaw (Юрию):
       🎯 ВОРОНКА АКТИВНА ДЛЯ ПУБЛИКАЦИИ
       🔤 Кодовое слово: GLAVA_REALIZ
       📸 Карусель (10 слайдов): [URLs]
       📝 ПОДПИСЬ ДЛЯ INSTAGRAM: [...]
       📐 ТЗ КАРУСЕЛИ ДЛЯ ДИЗАЙНЕРА / Claude Design: [URL .md]
       📊 КАК РАБОТАЕТ ВОРОНКА: 7 шагов
       Кнопки: [📋 Кодовое слово] [📋 Подпись] [📐 Скачать ТЗ] [✅ Опубликовал]
       │
       │ Юрий публикует карусель → /published <url>
       ▼
[15] Подписчик пишет GLAVA_REALIZ в IG Direct
       │
       ▼
[16] ChatPlace ловит trigger → шлёт ссылку на TG-бот
       │
       ▼
[17] Подписчик жмёт → /start <code_word> в Telegram
       │
       ▼
[18] handlers.ts /start payload → INSERT subscribers, trackEvent('direct_received'),
       scheduleWarmupChain (T+0, T+2h, T+8h, T+24h)
       │
       ▼
[19] warmup-worker отправляет 3-4 сообщения по графику
       │
       ▼
[20] Подписчик жмёт оффер клуба → GetCourse оплата
       │
       ▼
[21] gc-group-polling (каждые 5 мин) → видит paid_at → trackEvent('paid')
       │
       ▼
[22] post-payment → invite в TG-чат клуба + 💰 Юрию
```

## Очереди (BullMQ + Redis)

| Очередь | Назначение | Concurrency |
|---|---|---|
| `audio_queue` | STT (Deepgram) | 4 |
| `reference_dl_queue` | Скачивание Reels по ссылке | 2 |
| `reference_process_queue` | Парсинг референса | 2 |
| `idea_queue` | Idea-builder | 2 |
| `content_queue` | Content-gen | 2 |
| `visual_queue` | Carousel-renderer | 1 |
| `funnel_queue` | Прогрев warmup | 4 |
| `getcourse_pull_queue` | GetCourse API pull | 1 |

## Базы данных

- **PostgreSQL** — 30 таблиц (ideas, content_packages, funnels, subscribers, payments, …)
- **Redis** — BullMQ очереди + кэш SVG-шаблонов

## Интеграции

- **Anthropic** — Sonnet 4.6 (generative), Opus 4.7 (thinking, для редких задач)
- **Deepgram** — STT русский (nova-3)
- **GPTunnel** — Seedream-4 для AI-генерации картинок (8 ₽ / image)
- **ChatPlace** — IG Direct автоматизация
- **GetCourse** — приём оплат + статусы клуба
- **Google Drive** — SVG-шаблоны каруселей (folder GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID)
- **Cloudinary** — fallback для картинок (если local /var/www/cdn недоступен)
