# Backlog — club-funnel-agent

Список отложенных задач с приоритетами. Обновляется агентом по мере появления новых решений.

Приоритеты:
- **P0** — блокеры, ломают прод
- **P1** — нужно на этой неделе
- **P2** — нужно в течение 1–2 недель
- **P3** — когда дойдут руки

---

## P0 — Активные блокеры

(нет на 2026-05-14)

---

## P1 — Эта неделя

### P1.1 — Реальные картинки каруселей (заменить placeholder)

**Контекст:** `NANO_BANANA_PLACEHOLDER_MODE=true` сейчас включён, т.к. VPS Beget в РФ блокируется Gemini API (`FAILED_PRECONDITION: User location is not supported`). Попробован Cloudflare WARP — не помог: `loc=RU` в trace, Google всё равно режет.

**Варианты:**
1. **Cloudflare Worker как реверс-прокси для Gemini** (рекомендую): задеплоить готовый open-source `gemini-proxy` (npm/github), Worker free-tier ≥100k запросов/день. Нужен Cloudflare account + `wrangler login`. После — поменять base URL в `src/integrations/nano-banana.ts` или через новый env `GEMINI_API_BASE`.
2. **2-й VPS вне РФ** как HTTP-прокси (Hetzner CX11 €4.5/мес, DO droplet $4/мес). Поставить tinyproxy/squid, прописать через `HTTP_PROXY` env в pm2.
3. **WARP+** ($1.99/мес) — даёт выход через не-RU IP, в отличие от free.
4. **Datacenter-прокси сервис** (ProxyEmpire/Webshare $5-10/мес) — готовое решение.

**Action:** Юрий выбирает вариант → агент деплоит за 10-30 мин.

### P1.2 — Восстановить отправку картинок-каруселей с текстом

**Контекст:** При placeholder картинки серые. Текст слайдов теперь шлётся отдельным сообщением (фикс этой сессии).

**Идея на будущее:** в placeholder-режиме рисовать текст слайда поверх PNG через Sharp+SVG. Тогда даже без Gemini Юрий видит читабельные карусели (как заглушка).

---

## P2 — 1–2 недели

### P2.1 — AC-16 Outline Approval UI (стратегия C)

**Контекст:** Сейчас `STRATEGY_COLD_START_FALLBACK_B=true` обходит C. Когда наберётся `bonus_library` (через strategy_c source или через ручной seed) — нужно реальное С с outline approval.

**Что сделать:**
- content-worker для strategy=C: сначала генерит `outline` (JSONB), сохраняет, не запускает full longread
- approval-notifier: новая ветка отправки outline + 4 кнопки (Принять/Переделать/Коммент/Отменить — UI уже сделан в этой сессии для content_packages, надо аналогично для outlines)
- callback handler: на Принять → запускает longread-generation; на Переделать → re-prompt с фидбеком
- Новая таблица `outlines` ИЛИ поле `content_packages.outline_approved_at` + `outline JSONB`

**Оценка:** 2–3 часа dev.

### P2.2 — GetCourse подключение

**Контекст:** `GC_PULL_DISABLED=true` сейчас, GC API base/token/secret пока не известны. Юрий сам найдёт человека и пришлёт креды.

**Action:** Когда придут `GC_API_BASE`, `GC_API_TOKEN`, `GC_WEBHOOK_SECRET`:
1. Записать в `.env` на VPS.
2. Снять флаг `GC_PULL_DISABLED=false`.
3. Перезапустить pm2.
4. Проверить cron и pull.

### P2.3 — Comment flow для approval

**Контекст:** Кнопка «💬 Коммент» сейчас просит текст следующим сообщением + ставит маркер `awaiting_comment_at`. Сам захват комментария и регенерация с правками — TODO.

**Что сделать:**
- В bot/handlers.ts: при `m.text` после `awaiting_comment_at` — взять последний package с этим маркером, добавить в `validator_report.user_comment`, очистить маркер.
- Опция: автоматически re-enqueue content-gen с этим комментом.

---

## P3 — Когда дойдут руки

### P3.1 — Реальный GDrive шаблоны каруселей (AC-19)
Сейчас используется generic Nano Banana промпт. Юрий когда-то хотел брендированные шаблоны из GDrive.

### P3.2 — RAPIDAPI_KEY (Instagram media)
В `.env` стоит `changeme`. Нужен для скачивания референсов из IG. Сейчас работает через yt-dlp.

### P3.3 — Production security
- ed25519 SSH-ключи + disable PasswordAuth
- Revoke и replace GitHub PAT
- Move root password into Bitwarden
- ufw rules audit

### P3.4 — LUKS full-disk encryption
Требует переустановки ОС (SPEC §10). 152-ФЗ для ПД. Отложено до прод-релиза.

### P3.5 — Production seed bonus_library
Сейчас пустая → strategy всегда B (через fallback). Когда захотим реальные long-read'ы — нужен seed (минимум 5-10 базовых лонгридов с embeddings через OpenAI).
