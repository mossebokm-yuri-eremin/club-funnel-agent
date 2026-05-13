# club-funnel-agent — Setup Log

## 🚀 Сессия 2026-05-12 → 2026-05-13 — ДЕПЛОЙ КОДА НА VPS (в работе)

### Контекст

После прошлой сессии VPS был настроен, но SSH с Mac → `62.217.179.169:22` снова
перестал работать: `kex_protocol_error type 20/30` от sshd до этапа авторизации.
Beget Support (Антон, Дмитрий, Илья, София Николаевна) подтвердили, что
блокировок по IP нет, sshd жив. Воспроизводится с домашнего Wi-Fi,
iPhone hotspot, VPN Латвия/Молдова. Гипотеза — Beget edge DPI режет SSH.

**Обход:** SSH через jump-host — web-shell виртуального хостинга Beget
`mossebds@crumble.beget.com` → оттуда `ssh root@62.217.179.169`. Изнутри
сети Beget блокировки нет. Web-shell поддерживает copy-paste (в отличие
от VNC, который у Юрия глючит).

### Шаги деплоя (2026-05-13)

| # | Шаг | Резюме | Статус |
|---|-----|--------|--------|
| 1 | Jump-host SSH | `mossebds@crumble.beget.com` → `ssh root@62.217.179.169` | ✅ Welcome Ubuntu 24.04 |
| 2 | git clone | `https://github.com/.../club-funnel-agent.git /opt/club-funnel` через GitHub PAT | ✅ 93 объекта |
| 3 | apt stack | build-essential, ffmpeg, libvips/libvips-dev, python3, ufw, fail2ban, htop, jq | ✅ STACK_OK |
| 4 | Node 22 LTS + pnpm 11 + pm2 | NodeSource setup_22.x | ✅ |
| 5 | Postgres 16 + pgvector | pgdg apt repo | ✅ |
| 6 | Redis 7 + nginx + certbot | apt | ✅ |
| 7 | Chromium-deps | libnss3, libatk*-0t64, libcups2t64, libasound2t64 (новые имена в Ubuntu 24.04) | ✅ |
| 8 | yt-dlp | pip3 --break-system-packages | ✅ (уже стоял) |
| 9 | Пользователь club + директории | /opt/club-funnel, /var/log/club-funnel, /mnt/data/refs, /var/lib/ytdlp, /var/www/cdn | ✅ USER_DIRS_OK |
| 10 | /etc/club-funnel/.env | heredoc cat > с реальными секретами; chmod 640, owner root:club | ✅ 62 строки, 1756 байт |
| 11 | БД + роли | admin_dba/app_runtime, CREATE DATABASE club_funnel, pgcrypto + vector | ✅ (admin_dba уже был с прошлой сессии) |
| 12 | git push Phase 0-6 с Mac | 9 коммитов 316b8d3..d4bf224 на GitHub через PAT | ✅ |
| 13 | git pull + pnpm install + migrate + build | (в работе, 5-10 мин sharp компилируется) | ⏳ |
| 14 | pm2 start ecosystem.config.cjs | (после BUILD_OK) | ⏳ |
| 15 | nginx site agent.yury-eremin.ru | `scripts/nginx-agent.conf` готов на Mac | 🟡 готов |
| 16 | DNS A-запись + TLS certbot | требует ручной настройки A-записи на 62.217.179.169 | ⏳ |
| 17 | Telegram webhook | `https://agent.yury-eremin.ru/webhook/telegram` с TG_WEBHOOK_SECRET | ⏳ |
| 18 | Развернуть ed25519 key + отключить PasswordAuth | (после успешного start) | ⏳ |

### Безопасность — TODO после успешного запуска

- [ ] Revoke GitHub PAT `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` (был в чате с Claude)
- [ ] Сменить пароли БД через `ALTER ROLE admin_dba/app_runtime PASSWORD '...'` (были в чате)
- [ ] Сменить root password через `passwd` (`KN8A6#jaZs#y` был в чате + случайно ввёл как команду в bash)
- [ ] Развернуть `~/.ssh/id_ed25519.pub` в `/root/.ssh/authorized_keys`
- [ ] Отключить PasswordAuthentication в sshd_config
- [ ] Очистить `/root/.bash_history` на VPS финально
- [ ] Сохранить итоговый `/etc/club-funnel/.env` в Bitwarden коллекцию «MOSSEBO Production»

### Известные deferred-задачи (SPEC отклонения)

- **LUKS** — без переустановки ОС. Компенсация: pgcrypto extension на уровне БД.
- **GDrive шаблоны каруселей (AC-19)** — Phase 5 использует brand-palette generation
  без GDrive templates. Возврат — Phase X.
- **EC-19 simplify-on-retry** для Nano Banana content-policy refuse — не реализован
  (generic backoff).
- **EC-20 signed URLs 30d** для local CDN fallback — не реализованы.
- **Vitest на Mac** — не прогнан (RAM 54 MB free + node 24 + vitest 2.1.9 несовместимость).
  Гейт пройдёт на VPS под node 22 LTS.

---



### Инфраструктура

| Компонент | Значение |
|---|---|
| **VPS** | Beget Breezy Harper (dhoicofbbq), 62.217.179.169, SPB |
| **CPU/RAM/Disk** | 6 ядер / 12 ГБ / 150 ГБ NVMe |
| **ОС** | Ubuntu 24.04.4 LTS (свежая переустановка) |
| **Домен** | agent.yury-eremin.ru → 62.217.179.169 |
| **TLS** | Let's Encrypt, до 2026-08-09, auto-renew |
| **HTTPS** | Работает (nginx отвечает 502 — нормально, приложения нет) |

### Установлено

- Node.js v22.22.2 + pnpm 11.0.9 + pm2
- PostgreSQL 16.13 + pgvector + pgcrypto
- Redis 7.0.15
- nginx 1.24.0
- yt-dlp + Chromium-deps
- ffmpeg, build-essential, fonts-inter
- UFW (22, 80, 443) + fail2ban
- certbot для auto-renewal TLS

### БД

- **БД:** `club_funnel`
- **Роли:** `admin_dba` (SUPERUSER) и `app_runtime`
- **Кредиты:** `/etc/club-funnel/db.env` (chmod 600)
  - ⚠️ Сохранить в Bitwarden коллекцию «MOSSEBO Production»

### Доступ

- Пользователь `club` (для приложения)
- Директории: `/etc/club-funnel`, `/var/log/club-funnel`, `/mnt/data`, `/var/lib/ytdlp`
- SSH-ключ ed25519 добавлен в `/root/.ssh/authorized_keys`
- PasswordAuthentication отключён в `/etc/ssh/sshd_config`
- Root пароль (резерв): `KN8A6#jaZs#y` (нужно сохранить в Bitwarden)

### 🟡 Известный вопрос — SSH из моего IP

Beget блокирует IP `213.159.78.70` на сетевом уровне (не на VPS). Сам сервер настроен корректно. Если потребуется прямой SSH с локального Mac — нужно ещё раз попросить Beget разблокировать через тикет.

Сейчас работа через jump-host: `ssh -J mossebds@crumble.beget.com root@62.217.179.169`

---

## 📋 Дальше (следующие этапы)

### Немедленно

- [ ] Сохранить `/etc/club-funnel/db.env` в Bitwarden («VPS DB — club_funnel»)
- [ ] Сохранить root-пароль `KN8A6#jaZs#y` в Bitwarden («VPS root — Breezy Harper»)
- [ ] Тикет Beget — попросить ещё раз разблокировать IP 213.159.78.70

### Деплой приложения (когда SPEC будет готов)

- [ ] Создать репо `club-funnel-agent` на GitHub
- [ ] Запушить код приложения
- [ ] На VPS: `git clone` → `pnpm install` → `pm2 start`
- [ ] Миграции: 001_initial.sql + 002_seed_voices.sql
- [ ] Telegram webhook → https://agent.yury-eremin.ru/telegram
- [ ] Подключение ChatPlace API (ключ в Bitwarden)

---

## 📂 Кред-сводка

| Сервис | Где хранится |
|---|---|
| VPS root пароль | `KN8A6#jaZs#y` → Bitwarden |
| DB admin_dba / app_runtime | `/etc/club-funnel/db.env` → Bitwarden |
| Telegram Bot token | Bitwarden |
| ChatPlace API | Bitwarden |
| SSH ключ | `~/.ssh/id_ed25519` (Mac) + `/root/.ssh/authorized_keys` (VPS) |

## 📦 Артефакты

- Install-скрипт: https://termbin.com/bc4g (резерв на termbin)
- Локальная копия: `/tmp/install-club-funnel.sh`
- Лог установки на VPS: `/root/install.log`

---

---

## 🚀 Сессия 2026-05-13 → 2026-05-14 — E2E pipeline + кнопки approval

### Что сделано автономно через Tailscale-SSH
- Исправлено 4 бага в коде (BullMQ jobId с `:`, Anthropic thinking format для opus-4-7, strategy cold-start fallback, Nano Banana placeholder для геоблока).
- 7 голосовых ("5 заблуждений дизайнеров") прошли весь pipeline: voice → STT → idea → strategy → content → carousel → Telegram. Юрий получил пакеты в @Realizacia_marketing_bot.
- Реализованы кнопки одобрения (✅ Принять / 🔄 Переделать / 💬 Коммент / ❌ Отменить) под каждым content_package — callback handler в боте обновляет approval_status в БД.
- approval-notifier теперь шлёт отдельным сообщением текст карусели (нумерованный список слайдов) — Юрий видит контент даже при placeholder картинках.
- Установлен Cloudflare WARP на VPS — НЕ обходит геоблок Gemini (loc=RU остаётся). См. backlog.md P1.1.
- `GC_PULL_DISABLED=true` в .env — getcourse_pull воркер отключён, cron тоже. Спам 404 прекратится после pm2 restart.
- `pm2-logrotate` установлен (10M, 7 дней, compress).
- `/root/.bash_history` и `/home/club/.bash_history` зачищены.
- Созданы `credentials-recovery-plan.md` и `backlog.md` (P0/P1/P2/P3).

### TODO для Юрия
- Подключить GetCourse: найти человека, получить `GC_API_BASE` / `GC_API_TOKEN` / `GC_WEBHOOK_SECRET`, прислать агенту → агент развернёт за 10 мин (см. `backlog.md` P2.2).
- Решить про прокси Gemini: 4 варианта в `backlog.md` P1.1. Рекомендую Cloudflare Worker proxy.
- Сохранить копию `.env` и креды по `credentials-recovery-plan.md`.

### Env-флаги обхода (включены сейчас на VPS)
```
STRATEGY_COLD_START_FALLBACK_B=true   # bonus_library пустая → B вместо C
NANO_BANANA_PLACEHOLDER_MODE=true     # серый PNG вместо Gemini (геоблок РФ)
GC_PULL_DISABLED=true                 # GetCourse pull выключен до кредов
```

---

## История проблем (для запоминания)

- ⚠ Beget VPS не предлагает LUKS из коробки → используем pgcrypto на уровне БД
- ⚠ Beget блокирует IP fail2ban'ом после нескольких неудачных SSH попыток (на сетевом уровне)
- ⚠ Веб-консоль Beget может глючить — не всегда показывает ввод
- ✅ Jump-host через `mossebds@crumble.beget.com` работает обходным путём
- ✅ Install-скрипт через termbin.com сработал — установил всё за ~20 минут
