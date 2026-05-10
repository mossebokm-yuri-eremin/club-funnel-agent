# club-funnel-agent

Контент-агент Юрия Еремина (YE), приводящий дизайнеров интерьеров в клуб «Реализация» (5 000 ₽/мес). Полная спецификация — в [`SPEC.md`](./SPEC.md). Инструкция для Claude Code — в [`CLAUDE.md`](./CLAUDE.md).

> **Единственная цель:** подписка в клуб. Никаких продаж наставничества, мини-курсов или других продуктов лестницы.

## Что внутри

- Telegram-бот (grammY) — единый интерфейс Юрия.
- Две точки входа: голосовая идея и пересланный референс из Instagram.
- Три стратегии воронок: A (готовый лонгрид), B (без лонгрида), C (новый лонгрид).
- Библиотека брендированных PDF-лонгридов (Puppeteer + Google Drive).
- Интеграции: ChatPlace (доставка в Direct), GetCourse (касса), Instagram Graph, Gemini 2.5 Pro Video, Nano Banana Pro.
- Аналитика сквозной воронки + еженедельный отчёт + retrain через `winning_patterns`.
- 152-ФЗ: ПД хранятся только на Beget VPS (РФ).

## Стек

Node.js 22 LTS · TypeScript strict · PostgreSQL 16 + pgvector · Redis · BullMQ · grammY · Anthropic SDK (Sonnet 4.6 / Opus 4.7 / Haiku 4.5) · Google AI SDK (Gemini 2.5 Pro / 3 Pro Image) · Deepgram Nova-3 · Puppeteer · Sharp · Cloudinary · Fastify (webhooks) · Next.js 14 (dashboard) · Biome · Vitest.

## Структура репо

```
src/
  bot/              grammY handlers
  core/             бизнес-правила без I/O
  services/         stt, idea-builder, strategy-chooser, content-gen,
                    longread-factory, voice-validator, ...
  integrations/     anthropic, gemini, deepgram, chatplace,
                    getcourse, instagram, ytdlp, cloudinary, gdrive
  webhooks/         fastify routes (HMAC-валидация)
  jobs/             BullMQ workers
  prompts/          system prompts (TypeScript const)
  db/               pg client, миграции, repositories
  observability/    pino logger, prometheus
templates/          longread.hbs, slide-template.hbs
migrations/         001_initial.sql, 002_seed_voices.sql, ...
tests/              Vitest
docs/               152fz-policy.md, runbooks, ADRs
```

## Локальный запуск

### Требования

- Node.js 22.x LTS, pnpm 9+.
- PostgreSQL 16 с расширением pgvector.
- Redis 7+.
- Python 3.11+ и `yt-dlp` (`pip install -U yt-dlp`).
- Headless Chromium для Puppeteer (ставится автоматически).
- LibreOffice / ffmpeg — для обработки референсов.

### Шаги

```bash
# 1. Клонируем репо и ставим зависимости
git clone git@github.com:mossebo/club-funnel-agent.git
cd club-funnel-agent
pnpm install

# 2. Поднимаем PG + Redis локально (через docker-compose)
docker compose up -d pg redis

# 3. Готовим .env
cp .env.example .env
chmod 600 .env
# Заполняем sandbox-креды (Anthropic dev key, тестовый GC, тестовый Cloudinary).

# 4. Применяем миграции
pnpm migrate:up
# Применит 001_initial.sql и 002_seed_voices.sql

# 5. Загружаем wiki и /knowledge/ в knowledge_base
pnpm refresh:brain

# 6. Запускаем
pnpm dev
# Бот запустится в long-polling режиме на YE_TG_USER_ID.
# Webhook receiver: http://localhost:3000/webhook/{getcourse,chatplace,instagram}
# Метрики: http://localhost:9090/metrics
# Healthz:  http://localhost:3000/healthz
```

### Проверочный сценарий локально

```
1) В Telegram пишем боту голосовое — должно прийти "Принял голосовое, расшифровываю".
2) Через 10–30 сек — сообщение со стратегией (A/B/C) и обоснованием.
3) Согласовываем структуру (если C) → согласовываем тексты → согласовываем карусель.
4) В чате с Анной (DEV_DRY_RUN можно включить) появляются карусели.
5) В дашборде /dashboard видна свежая запись funnel.
```

### Тесты

```bash
pnpm typecheck
pnpm lint            # Biome
pnpm test            # Vitest
pnpm test:watch
pnpm test:coverage
```

Перед PR — все три зелёные.

## Production: Beget VPS

### Подготовка сервера

```bash
# Ubuntu 24.04, 4 vCPU, 8 GB RAM, 100 GB SSD.

# Базовый софт
apt update && apt -y upgrade
apt install -y nginx postgresql-16 postgresql-16-pgvector redis-server \
               python3-pip ffmpeg fonts-inter ca-certificates curl
pip3 install -U yt-dlp

# Node.js 22 (через nodesource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm i -g pnpm pm2

# Пользователь приложения
useradd -r -m -s /bin/bash club
mkdir -p /etc/club-funnel /var/log/club-funnel /mnt/data
chown -R club:club /var/log/club-funnel /mnt/data
```

### LUKS / шифрование диска

При первичной установке VPS Beget — выбрать опцию полнодискового шифрования. Если не было — выполнить миграцию данных в зашифрованный том отдельной задачей.

### TLS

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d agent.yury-eremin.tld
# Автообновление по cron уже настроено certbot'ом.
```

### Деплой

```bash
# Как пользователь club:
git clone git@github.com:mossebo/club-funnel-agent.git /home/club/app
cd /home/club/app
pnpm install --frozen-lockfile
pnpm build

cp .env.example /etc/club-funnel/.env
chmod 600 /etc/club-funnel/.env
chown club:club /etc/club-funnel/.env
# Заполняем prod-креды.

# Миграции (от admin_dba!)
PG_USER=$PG_DBA_USER PG_PASSWORD=$PG_DBA_PASSWORD pnpm migrate:up

# Запуск через pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd  # генерирует команду — выполнить от root
```

### nginx

`/etc/nginx/sites-available/club-funnel`:

```nginx
server {
  listen 443 ssl http2;
  server_name agent.yury-eremin.tld;
  ssl_certificate     /etc/letsencrypt/live/agent.yury-eremin.tld/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/agent.yury-eremin.tld/privkey.pem;

  client_max_body_size 50M;        # для прямых видео-загрузок при ручном fallback

  # Webhooks
  location /webhook/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # КРИТИЧНО: не трогаем body, чтобы HMAC GetCourse оставался валидным
    proxy_request_buffering on;
    proxy_buffering off;
  }

  # Healthz/Readyz/Metrics — только для внутренних IP (или allowlist)
  location ~ ^/(healthz|readyz|metrics)$ {
    allow 127.0.0.1;
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:3000;
  }

  # Дашборд (Next.js)
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
  }

  # Локальный CDN (fallback Cloudinary)
  location /cdn/ {
    alias /var/www/cdn/;
    expires 30d;
    add_header Cache-Control "public, immutable";
  }
}
```

### pm2

`ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'club-funnel-bot',
      script: 'dist/bot/index.js',
      instances: 1, exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      env_file: '/etc/club-funnel/.env',
      max_memory_restart: '900M'
    },
    {
      name: 'club-funnel-webhooks',
      script: 'dist/webhooks/index.js',
      instances: 1, exec_mode: 'fork',
      env_file: '/etc/club-funnel/.env'
    },
    {
      name: 'club-funnel-workers',
      script: 'dist/jobs/index.js',
      instances: 1, exec_mode: 'fork',
      env_file: '/etc/club-funnel/.env'
    },
    {
      name: 'club-funnel-cron',
      script: 'dist/jobs/cron.js',
      instances: 1, exec_mode: 'fork',
      env_file: '/etc/club-funnel/.env'
    },
    {
      name: 'club-funnel-dashboard',
      script: 'dashboard/.next/standalone/server.js',
      instances: 1, exec_mode: 'fork',
      env: { PORT: 3001 },
      env_file: '/etc/club-funnel/.env'
    }
  ]
};
```

### Регистрация webhook'ов

После первого деплоя:

1. **Telegram:**
   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://agent.yury-eremin.tld/webhook/telegram&secret_token=$TG_WEBHOOK_SECRET"
   ```
2. **Instagram:** в Meta App Dashboard добавить webhook на `https://agent.yury-eremin.tld/webhook/instagram`, поля `comments`, `mentions`, verify-token из `IG_WEBHOOK_VERIFY_TOKEN`.
3. **GetCourse:** в `Настройки → Уведомления → Уведомления для внешних систем` — endpoint `https://agent.yury-eremin.tld/webhook/getcourse`, события `deal.success`, `deal.refund`, секрет — `GC_WEBHOOK_SECRET`.
4. **ChatPlace:** в UI ChatPlace добавить webhook на тот же хост, `/webhook/chatplace`, токен — `CHATPLACE_WEBHOOK_TOKEN`.

### Бэкапы

```bash
# /etc/cron.d/club-funnel-backup
0 2 * * * postgres pg_dump club_funnel | gpg --symmetric --batch --passphrase-file /root/.gpg-passphrase > /var/backups/cf-$(date +\%F).sql.gpg
0 3 * * * root rsync -a /mnt/data/ /var/backups/data/
```

Пароль шифрования бэкапов хранится в Bitwarden, копия — на отдельном offline-носителе.

### Ротация секретов

| Секрет | Период | Кто ротирует |
|---|---|---|
| Anthropic API key | 90 дней | DevOps |
| GetCourse webhook secret | 180 дней | DevOps + регистрация в GC |
| ChatPlace API key | 180 дней | DevOps + регистрация в CP |
| IG Page Access Token | 30 дней (long-lived auto-refresh cron) | автоматически |
| Telegram bot token | при компрометации | вручную |
| `app_runtime` пароль PG | 180 дней | DevOps + рестарт pm2 |

## Команды Юрия в Telegram

| Команда | Что делает |
|---|---|
| (голосовое или текст) | новая идея — Вход А |
| (пересланный Reels/пост из IG) | новый референс — Вход Б, ждёт голосовое с углом |
| `/build_library` | запустить генерацию следующего лонгрида по приоритету |
| `/refresh_brain` | перечитать wiki + /knowledge/, обновить library_plan |
| `/references` | каталог референсов (TG Mini App) |
| `/dashboard` | ссылка на веб-дашборд |
| `/pause` / `/resume` | приостановить / возобновить очередь идей |
| `/forget <email\|phone>` | soft-delete подписчика (152-ФЗ) |
| `/status` | счётчики очередей, бюджеты |
| `/ping` | health-check (бот отвечает «pong») |

## Документация

- [`SPEC.md`](./SPEC.md) — полное техническое задание (13 секций).
- [`CLAUDE.md`](./CLAUDE.md) — инструкция Claude Code в этом репо.
- [`docs/152fz-policy.md`](./docs/152fz-policy.md) — политика обработки ПД.
- [`docs/runbooks/`](./docs/runbooks/) — действия при инцидентах.
- [`docs/adr/`](./docs/adr/) — архитектурные решения.

## Лицензия

Проприетарная. © Юрий Еремин / MOSSEBO. Без права копирования и переиспользования.
