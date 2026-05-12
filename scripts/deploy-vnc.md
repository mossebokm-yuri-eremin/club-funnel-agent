# Деплой через VNC-консоль Beget — пошаговая инструкция

> Используй когда SSH к VPS не работает. Каждый блок — отдельная команда.
> Копируй блок целиком, вставляй в VNC-консоль, жми Enter, жди пока отработает.
>
> Если VNC не реагирует на ввод — попробуй: правый Cmd+V, Cmd+Shift+V,
> двойной клик в окно консоли (фокус), либо ввод вручную (минимум первого блока,
> дальше скрипт скачается).

---

## 0. Войти в VNC-консоль

1. Открой `https://cp.beget.com` → раздел «VPS» → твой сервер `62.217.179.169` → кнопка «Консоль» (или «VNC»).
2. На приглашение `login:` введи `root`, на `Password:` — `KN8A6#jaZs#y` (пароль на экране не печатается — это нормально).
3. Когда увидишь `root@...:~#` — ты внутри.

---

## 1. Один большой блок: всё разом через bash heredoc

Скопируй блок ниже **целиком** (от `bash <<'DEPLOY'` до `DEPLOY`) и вставь в VNC. Команды выполнятся последовательно. Время ~10-15 минут.

```bash
bash <<'DEPLOY'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== 1/14 apt update + базовый софт ==="
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential curl ca-certificates git ffmpeg fonts-inter \
  python3 python3-pip ufw fail2ban htop jq unzip \
  libvips libvips-dev

echo "=== 2/14 Node 22 LTS + pnpm + pm2 ==="
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@11 pm2

echo "=== 3/14 PostgreSQL 16 + pgvector ==="
if ! command -v psql >/dev/null; then
  install -d /etc/apt/keyrings
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/keyrings/postgresql.gpg
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [signed-by=/etc/apt/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt/ ${CODENAME}-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-16 postgresql-16-pgvector
fi
systemctl enable --now postgresql

echo "=== 4/14 Redis 7 ==="
apt-get install -y redis-server
systemctl enable --now redis-server

echo "=== 5/14 nginx + certbot ==="
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable --now nginx

echo "=== 6/14 yt-dlp + Puppeteer/Chromium deps ==="
pip3 install --break-system-packages -U yt-dlp
apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1

echo "=== 7/14 Пользователь club + директории ==="
id -u club &>/dev/null || useradd -m -s /bin/bash club
install -d -o club -g club /opt/club-funnel /var/log/club-funnel /mnt/data /var/lib/ytdlp /mnt/data/refs /var/www/cdn
install -d /etc/club-funnel
chown root:club /etc/club-funnel
chmod 750 /etc/club-funnel
chown -R club:club /var/www/cdn

echo "=== 8/14 git clone (репо публичный, или жди deploy key) ==="
if [[ ! -d /opt/club-funnel/.git ]]; then
  sudo -u club git clone https://github.com/mossebokm-yuri-eremin/club-funnel-agent.git /opt/club-funnel
else
  sudo -u club git -C /opt/club-funnel fetch --all
  sudo -u club git -C /opt/club-funnel reset --hard origin/main
fi

echo "=== 9/14 ПОДГОТОВЬ .env (см. следующий блок ниже!) ==="
echo "Если /etc/club-funnel/.env уже есть — пропускаем."
if [[ ! -f /etc/club-funnel/.env ]]; then
  echo "⚠️  /etc/club-funnel/.env не найден."
  echo "    Сейчас выйди из этого heredoc-блока, выполни блок №2 (создание .env),"
  echo "    затем запусти блок №3 (БД + миграции + pm2)."
  exit 0
fi

echo "=== 10/14 БД club_funnel + роли (если ещё не созданы) ==="
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='club_funnel'" | grep -q 1 || {
  PG_PASS=$(grep '^PG_PASSWORD=' /etc/club-funnel/.env | cut -d= -f2-)
  DBA_PASS=$(grep '^PG_DBA_PASSWORD=' /etc/club-funnel/.env | cut -d= -f2-)
  sudo -u postgres psql <<SQL
CREATE ROLE admin_dba LOGIN PASSWORD '${DBA_PASS}' CREATEDB CREATEROLE;
CREATE ROLE app_runtime LOGIN PASSWORD '${PG_PASS}';
CREATE DATABASE club_funnel OWNER admin_dba;
\c club_funnel
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
}

echo "=== 11/14 pnpm install + миграции + build ==="
cd /opt/club-funnel
ln -sf /etc/club-funnel/.env /opt/club-funnel/.env
sudo -u club -H pnpm install --frozen-lockfile
sudo -u club -H pnpm migrate:up
sudo -u club -H pnpm build

echo "=== 12/14 pm2 startup ==="
sudo -u club -H pm2 startOrReload ecosystem.config.cjs --update-env
sudo -u club -H pm2 save
pm2 startup systemd -u club --hp /home/club 2>/dev/null | tail -1 | bash || true

echo "=== 13/14 ufw + fail2ban + nginx /cdn alias ==="
ufw --force allow OpenSSH
ufw --force allow 80/tcp
ufw --force allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
# nginx /cdn → /var/www/cdn (для local Cloudinary fallback)
cat >/etc/nginx/conf.d/cdn.conf <<NGINX
location /cdn/ {
    alias /var/www/cdn/;
    add_header Cache-Control "public, max-age=2592000";
    autoindex off;
}
NGINX
nginx -t && systemctl reload nginx

echo "=== 14/14 Готово ==="
echo "Проверь:"
echo "  pm2 list"
echo "  curl -sI https://agent.yury-eremin.ru/health"
echo "  sudo -u club tail -50 /var/log/club-funnel/out.log"
DEPLOY
```

---

## 2. Создать `/etc/club-funnel/.env` (если ещё не создан)

Этот блок создаёт .env с **реальными секретами** на VPS. Скопируй **полностью** (от `cat > /etc/club-funnel/.env <<'ENV_END'` до `ENV_END`) и вставь в VNC. Реальные секреты внутри `<…>` заменяй на свои значения **до вставки в консоль**.

```bash
cat > /etc/club-funnel/.env <<'ENV_END'
NODE_ENV=production
APP_NAME=club-funnel-agent
APP_HOST=127.0.0.1
APP_PORT=3000
APP_PUBLIC_BASE_URL=https://agent.yury-eremin.ru
TZ=Europe/Moscow

PG_HOST=127.0.0.1
PG_PORT=5432
PG_DATABASE=club_funnel
PG_USER=app_runtime
PG_PASSWORD=hvCYhS5PmZST0qHoOpatWcz4
PG_SSL=false
PG_POOL_MAX=20
PG_DBA_USER=admin_dba
PG_DBA_PASSWORD=EncINLFF3Z3570E1Q5hVPQ8O

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

ANTHROPIC_API_KEY=<скопируй из локального .env>
ANTHROPIC_MODEL_GENERATIVE=claude-sonnet-4-6
ANTHROPIC_MODEL_THINKING=claude-opus-4-7
ANTHROPIC_MODEL_FAST=claude-haiku-4-5-20251001
ANTHROPIC_THINKING_BUDGET_TOKENS=32000

GEMINI_API_KEY=<нужен — спросишь у Юрия / создашь в AI Studio>
GEMINI_VIDEO_MODEL=gemini-2.5-pro
GEMINI_IMAGE_MODEL=gemini-3-pro-image

DEEPGRAM_API_KEY=<нужен — спросишь у Юрия>
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=ru

OPENAI_API_KEY=<нужен для embeddings>
EMBEDDING_MODEL=text-embedding-3-large
EMBEDDING_DIM=1536

TELEGRAM_BOT_TOKEN=8616755055:AAHCRnoGHcqZwNBQR8UhvNu0oeS4wA9Jr6o
TELEGRAM_BOT_USERNAME=Realizacia_marketing_bot
YE_TG_USER_ID=<твой tg_user_id>
TG_WEBHOOK_SECRET=d558311d89014915519e5cb04dca4795c0ab7e75731ba78db8174b6e41b03a84

CHATPLACE_API_BASE=https://api.chatplace.io/v1
CHATPLACE_API_KEY=cpk_3e14c14c50ef2ef4c1fb902db15f688ece4ec698

GC_API_BASE=<домен GetCourse, например https://mossebo.getcourse.ru/pl/api>
GC_API_KEY=<api key GetCourse>
GC_ACCOUNT=mossebo
GC_BASE_OFFER_ID=<offer id клуба «Реализация» в GetCourse>
GC_WEBHOOK_SECRET=bd5c070751eced46cccc1fa47f746a032671af882f299757943ef38d9d10770f

RAPIDAPI_KEY=<нужен — RapidAPI Instagram Downloader>
RAPIDAPI_IG_HOST=instagram-downloader.p.rapidapi.com

CLOUDINARY_CLOUD_NAME=<если есть Cloudinary>
CLOUDINARY_API_KEY=<если есть Cloudinary>
CLOUDINARY_API_SECRET=<если есть Cloudinary>
CLOUDINARY_UPLOAD_FOLDER=club-funnel
CLOUDINARY_FALLBACK_LOCAL_DIR=/var/www/cdn

REFS_DIR=/mnt/data/refs

CRON_GC_RECONCILE=0 * * * *
ENV_END
chmod 640 /etc/club-funnel/.env
chown root:club /etc/club-funnel/.env
echo "OK: /etc/club-funnel/.env создан"
```

После этого блока запусти **блок 1 ещё раз** — он пройдёт шаги 10-14, которые пропустил в первый раз.

---

## 3. TLS-сертификат (выполнять только когда DNS уже указывает на 62.217.179.169)

```bash
certbot --nginx --non-interactive --agree-tos --email mossebokm@gmail.com -d agent.yury-eremin.ru
systemctl reload nginx
```

---

## 4. Регистрация Telegram webhook (после TLS)

```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /etc/club-funnel/.env | cut -d= -f2-)
SECRET=$(grep '^TG_WEBHOOK_SECRET=' /etc/club-funnel/.env | cut -d= -f2-)
BASE_URL=$(grep '^APP_PUBLIC_BASE_URL=' /etc/club-funnel/.env | cut -d= -f2-)
curl -fsS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${BASE_URL%/}/webhook/telegram\",\"secret_token\":\"${SECRET}\",\"drop_pending_updates\":true}"
echo
```

Если возвращает `{"ok":true,...}` — webhook зарегистрирован.

---

## 5. Smoke-проверки

```bash
pm2 list
curl -sI https://agent.yury-eremin.ru/health
sudo -u club tail -30 /var/log/club-funnel/out.log
sudo -u club tail -30 /var/log/club-funnel/error.log
```

`/health` должен ответить `200 OK`.

---

## 6. SSH hardening (после успешного деплоя)

Только когда SSH с твоего Mac заработает — переходим на ключи:

```bash
# 1. Развернуть твой ed25519-ключ для root
mkdir -p /root/.ssh && chmod 700 /root/.ssh
cat >> /root/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAAC3...твой_ключ_из_~/.ssh/id_ed25519.pub
KEY
chmod 600 /root/.ssh/authorized_keys

# 2. Отключить парольную аутентификацию
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload sshd

# 3. Сменить пароль root (он скомпрометирован, был в чате)
passwd root
```

---

## Если что-то пошло не так

- **`pm2 list` пустой** → `cd /opt/club-funnel && sudo -u club -H pm2 start ecosystem.config.cjs --update-env`
- **app падает с "Cannot find module"** → `cd /opt/club-funnel && sudo -u club -H pnpm install && sudo -u club -H pnpm build && sudo -u club -H pm2 restart all`
- **миграция упала** → проверь `/etc/club-funnel/.env` `PG_PASSWORD`/`PG_DBA_PASSWORD` совпадают с теми, что в postgres
- **/health отвечает 502** → `pm2 logs --lines 100` и пиши Юрию

---

## Что после деплоя — НЕ забыть

- [ ] Получить недостающие API-ключи (см. Phase 6 keys-needed.md):
  - `GEMINI_API_KEY` (Google AI Studio, бесплатный tier)
  - `RAPIDAPI_KEY` (RapidAPI Instagram Downloader, ~$10/мес)
  - `DEEPGRAM_API_KEY` (Deepgram, $200 free credits)
  - `OPENAI_API_KEY` (для embeddings text-embedding-3-large)
  - `GC_API_KEY` + `GC_BASE_OFFER_ID` из админки GetCourse
  - `CLOUDINARY_*` (опционально — без них local fallback на /var/www/cdn)
- [ ] Сменить пароли root + PG (KN8A6#jaZs#y, hvCYhS5..., EncINLFF... уже в чате)
- [ ] Сохранить итоговый .env в Bitwarden коллекцию «MOSSEBO Production»
