# Instagram Graph API — подключение для аналитики постов @yury.eremin

**Цель:** агент сможет читать твои посты, охваты, реакции; делать voice/topic analysis на реальных данных.

**Время на твоей стороне:** 15–25 минут (один раз).

---

## Что нужно сделать

### Шаг 1 — Подключи IG к Facebook Page

Если ещё не подключён:
1. В мобильном Instagram → **Настройки → Аккаунт → Связанные аккаунты → Facebook** → подключи свою Facebook страницу (если её нет — создай простую любым названием).
2. Профиль IG должен быть **Business** или **Creator** (в Настройках → Аккаунт → Переключиться на бизнес-аккаунт).

### Шаг 2 — Создай Facebook App

1. Открой [developers.facebook.com/apps](https://developers.facebook.com/apps).
2. Нажми **Create App** → выбери тип **Business** → Next.
3. Имя приложения: `Yury Eremin Analytics` (любое). Email: твой mossebokm@gmail.com. Создать.
4. В Dashboard → раздел **Add products** → найди **Instagram Graph API** → нажми Set up.

### Шаг 3 — Сгенерируй long-lived access token

1. В левом меню App → **Tools → Graph API Explorer**.
2. Выбери своё приложение в верхнем правом dropdown.
3. Нажми **Generate Access Token** → разреши Facebook доступ:
   - `instagram_basic`
   - `instagram_manage_insights`
   - `pages_show_list`
   - `pages_read_engagement`
   - `business_management`
4. Скопируй полученный short-lived token (≈2 часа жизни).
5. Конвертация в long-lived (60 дней):
   ```
   GET https://graph.facebook.com/v25.0/oauth/access_token?
     grant_type=fb_exchange_token&
     client_id={APP_ID}&
     client_secret={APP_SECRET}&
     fb_exchange_token={SHORT_LIVED_TOKEN}
   ```
   - `APP_ID` и `APP_SECRET` — в **Settings → Basic** твоего App.
   - Открой URL в браузере, замени `{...}` на свои значения, получишь JSON с long-lived `access_token`.

### Шаг 4 — Найди свой `IG_USER_ID`

1. В Graph API Explorer выполни запрос:
   ```
   GET /me/accounts?access_token={LONG_LIVED_TOKEN}
   ```
   → получишь список Facebook-страниц с `id` (это `page_id`).
2. Для нужной страницы — запрос:
   ```
   GET /{page_id}?fields=instagram_business_account&access_token={LONG_LIVED_TOKEN}
   ```
   → в ответе `instagram_business_account.id` — это твой `IG_USER_ID`.

### Шаг 5 — Передай ключи мне

Скинь сюда (или мне в TG) **три значения**:

```
IG_USER_ID=178...
IG_PAGE_ACCESS_TOKEN=EAA...
IG_APP_SECRET=...     # из Settings → Basic твоего FB App
```

(`IG_APP_SECRET` нужен для верификации webhook'ов от Meta, если потом будем подписываться на новые посты автоматом.)

---

## Что я сделаю после получения ключей

1. Положу в `.env` на VPS, перезапущу сервис.
2. Скачаю последние 12 мес. твоих постов через `/me/media?fields=id,caption,media_type,permalink,timestamp,like_count,comments_count,insights.metric(reach,impressions,saved)`.
3. Положу в новую таблицу `instagram_posts` + embeddings через GPTunnel.
4. OCR постов-каруселей где текст на картинках (Sonnet 4.5 Vision).
5. Аналитика топ-50 постов через Sonnet 4.6 → `knowledge/instagram-insights.md`:
   - Топ-5 тем по reach
   - Оптимальное время постинга
   - Оптимальная длина caption
   - Какие крючки в первой строке работают
   - Какие CTA конвертят
6. Эти данные используются как доп. KB при генерации новых постов в `twin-ye.v2.ts` (semantic search top-5 похожих твоих реальных постов).
7. `/admin/instagram/analytics` endpoint и TG-команда `/stats` — сводка.

---

## Долго ли живут ключи?

- `IG_PAGE_ACCESS_TOKEN` — 60 дней.
- Я подключу `CRON_IG_TOKEN_REFRESH='0 2 1 * *'` (1 число месяца в 02:00) — будет автоматически продлевать.
- Если когда-то перестанет работать — ты получишь алерт в TG `⚠️ IG token истёк, повтори шаги 3–5`.

---

## Privacy

- Все данные хранятся только на твоём VPS, никуда не отправляются.
- Доступ к raw данным только у тебя (через `/admin/...` endpoint с Bearer token).
- Embeddings и анализ — приватная сводка, не публичный отчёт.
