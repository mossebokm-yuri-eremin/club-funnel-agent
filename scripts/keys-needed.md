# API-ключи и параметры, которые нужно собрать перед деплоем

Этот файл — сводка из Phase 0-6. Все ключи кладутся в `/etc/club-funnel/.env`
на VPS (или локально в `.env` для разработки). Шаблон — в `.env.example`.

---

## ✅ Уже есть (в локальном .env)

| Ключ | Значение | Источник |
|------|----------|----------|
| `ANTHROPIC_API_KEY` | `sk-ant-api03-epzP...` | claude.ai |
| `TELEGRAM_BOT_TOKEN` | `8616755055:AAHC...` | BotFather |
| `TELEGRAM_BOT_USERNAME` | `Realizacia_marketing_bot` | BotFather |
| `TG_WEBHOOK_SECRET` | `d558311d...` | сгенерирован Architect |
| `CHATPLACE_API_KEY` | `cpk_3e14c14c...` | ChatPlace панель |
| `GC_WEBHOOK_SECRET` | `bd5c0707...` | сгенерирован Architect |
| `PG_PASSWORD` | `hvCYhS5PmZST0qHoOpatWcz4` | Beget (db.env) |
| `PG_DBA_PASSWORD` | `EncINLFF3Z3570E1Q5hVPQ8O` | Beget (db.env) |

---

## ⚠️ Нужно получить ДО первого реального запуска воронки

### 1. `GEMINI_API_KEY` — Google AI (Nano Banana Pro + Gemini Video)
- **Зачем:** рендер каруселей (Phase 5) + анализ видео-референсов (Phase 6)
- **Где:** https://aistudio.google.com → Get API Key
- **Стоимость:** бесплатный tier даёт ~10 RPM, для prod нужен paid tier (~$0.005/image)
- **Куда:** `GEMINI_API_KEY=AIza...`

### 2. `RAPIDAPI_KEY` — fallback на yt-dlp (Phase 6)
- **Зачем:** скачивание Instagram Reels/каруселей когда yt-dlp падает
- **Где:** https://rapidapi.com → marketplace → "Instagram Downloader" (несколько провайдеров)
- **Стоимость:** ~$10-25/мес за 10k запросов
- **Куда:** `RAPIDAPI_KEY=...` (`RAPIDAPI_IG_HOST` оставить default или поменять под выбранного провайдера)
- **Можно отложить:** yt-dlp обычно работает, без RapidAPI просто будет throw → ручной запрос Юрию

### 3. `DEEPGRAM_API_KEY` — STT для голосовых (Phase 2)
- **Зачем:** транскрибация голосовых от Юрия (nova-3, RU)
- **Где:** https://console.deepgram.com → API Keys
- **Стоимость:** $200 free credits, дальше ~$0.0043/мин
- **Куда:** `DEEPGRAM_API_KEY=...`

### 4. `OPENAI_API_KEY` — Embeddings (Phase 3, strategy chooser)
- **Зачем:** vector search в `bonus_library` (text-embedding-3-large, 1536 dim)
- **Где:** https://platform.openai.com → API Keys
- **Стоимость:** ~$0.13 / 1M токенов
- **Куда:** `OPENAI_API_KEY=sk-...`
- **Можно отложить:** strategy-chooser без embeddings всегда вернёт `C` (cold start)

### 5. GetCourse — `GC_API_BASE` + `GC_API_KEY` + `GC_BASE_OFFER_ID`
- **Зачем:** платежи за клуб «Реализация» (Phase 4 + 6, CLAUDE.md §6 «только GetCourse»)
- **Где:** админка GetCourse → Настройки → API
- **Что нужно:**
  - `GC_API_BASE` — например `https://mossebo.getcourse.ru/pl/api/account`
  - `GC_API_KEY` — secret key из админки
  - `GC_BASE_OFFER_ID` — ID оффера клуба (5000 ₽/мес)
- **Куда:** в `.env` соответствующие поля

### 6. Cloudinary (опционально)
- **Зачем:** CDN для каруселей (Phase 5)
- **Где:** https://cloudinary.com → Dashboard
- **Стоимость:** Free tier — 25k transformations/мес, 25GB storage
- **Куда:** `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Без него:** local fallback в `/var/www/cdn/{idea_id}/*.jpg` через nginx — работает но без CDN-преимуществ

### 7. `YE_TG_USER_ID` — твой Telegram user_id
- **Зачем:** allowlist в боте (только Юрий может слать команды)
- **Где:** напиши боту `@userinfobot` в Telegram, он вернёт твой ID
- **Куда:** `YE_TG_USER_ID=<число>`

### 8. `ANNA_TG_CHAT_ID` — чат с Анной для публикаций
- **Зачем:** после approval отправлять подготовленный контент Анне (Phase 4)
- **Где:** добавь бота в чат с Анной, потом смотри updates в logs
- **Куда:** `ANNA_TG_CHAT_ID=-100...` (отрицательное число для group chat)
- **Можно отложить:** до момента когда Анна реально подключится

### 9. Домен `agent.yury-eremin.ru` — A-запись
- **Зачем:** TLS-сертификат + публичный webhook URL
- **Где:** DNS-провайдер (Beget DNS или Cloudflare)
- **Что:** A-запись `agent.yury-eremin.ru → 62.217.179.169`
- **Без него:** certbot не выдаст cert, webhook не примет updates

### 10. Cloudflare WARP / Tunnel (если SSH к Beget продолжит падать)
- **Зачем:** обходной канал для деплоя без зависимости от Beget edge
- **Где:** https://one.dash.cloudflare.com → Tunnels
- **Можно отложить:** если SSH починят

---

## 🔐 Безопасность

Сразу после первого успешного деплоя:
1. Сменить пароль `root` VPS (`KN8A6#jaZs#y` в чате — скомпрометирован)
2. Сменить `PG_PASSWORD` и `PG_DBA_PASSWORD` через `ALTER ROLE ... PASSWORD '...'`
3. Развернуть ed25519 ключ, отключить `PasswordAuthentication` в sshd
4. Сохранить итоговый `.env` в Bitwarden коллекцию «MOSSEBO Production»

---

## Где спросить недостающие ключи

Если ключ не у тебя — пиши Юрию в Telegram, перечисли что нужно списком.
Все ключи опциональные на уровне config.ts (`z.string().optional()`),
так что отсутствие любого не ломает запуск приложения — просто отключает
соответствующую фичу.
