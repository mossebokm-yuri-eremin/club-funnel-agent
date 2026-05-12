#!/usr/bin/env bash
# deploy.sh — автоматический деплой club-funnel-agent на VPS Beget.
# Запускается с локального Mac. Когда SSH к VPS заработает — одна команда:
#   bash scripts/deploy.sh
#
# Что делает (на VPS под root):
#   1. apt update + базовый софт (если ещё нет)
#   2. Node 22 LTS + pnpm + pm2 (если ещё нет)
#   3. PostgreSQL 16 + pgvector (если ещё нет)
#   4. Redis 7 (если ещё нет)
#   5. nginx + certbot (если ещё нет; TLS пропустится если DNS не указывает на VPS)
#   6. Пользователь club + директории /opt/club-funnel /etc/club-funnel /var/log/club-funnel /mnt/data
#   7. БД club_funnel + роли admin_dba / app_runtime (если ещё нет)
#   8. Клон/pull репо https://github.com/<owner>/club-funnel-agent.git в /opt/club-funnel
#   9. pnpm install (включая dev для tsc)
#   10. /etc/club-funnel/.env — копия локального .env с PG_HOST=127.0.0.1
#   11. pnpm migrate:up (001, 002, 003)
#   12. pnpm build (TypeScript → dist/)
#   13. pm2 startOrReload ecosystem.config.cjs
#   14. Telegram webhook → https://agent.yury-eremin.ru/webhook/telegram
#
# Идемпотентность: все шаги проверяют состояние и пропускаются если уже сделано.

set -euo pipefail

VPS_HOST="${VPS_HOST:-club-funnel-vps}"
REPO_URL="${REPO_URL:-https://github.com/mossebokm-yuri-eremin/club-funnel-agent.git}"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-$(dirname "$0")/../.env}"
DEPLOY_LOG="$(dirname "$0")/../setup-log.md"

[[ -f "$LOCAL_ENV_FILE" ]] || { echo "❌ .env не найден: $LOCAL_ENV_FILE"; exit 1; }

echo "=== 0. SSH-проверка ==="
ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS_HOST" 'echo SSH_OK && hostname && uname -a' \
  || { echo "❌ SSH к $VPS_HOST не работает. Дождись разблокировки от Beget."; exit 2; }

echo
echo "=== 1. Загружаю локальный .env на VPS ==="
scp -o BatchMode=yes "$LOCAL_ENV_FILE" "$VPS_HOST":/tmp/club-funnel.env.new

echo
echo "=== 2. Запускаю remote-deploy ==="

ssh -o BatchMode=yes "$VPS_HOST" REPO_URL="$REPO_URL" 'bash -s' <<'REMOTE'
set -euo pipefail

REPO_DIR=/opt/club-funnel
ENV_FILE=/etc/club-funnel/.env

step() { echo; echo ">>> $*"; }

step "1/14 apt update + базовый софт"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  build-essential curl ca-certificates git ffmpeg fonts-inter \
  python3 python3-pip ufw fail2ban htop jq unzip \
  libvips libvips-dev

step "2/14 Node 22 LTS + pnpm + pm2"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g pnpm@11 pm2

step "3/14 PostgreSQL 16 + pgvector"
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

step "4/14 Redis 7"
apt-get install -y redis-server
systemctl enable --now redis-server

step "5/14 nginx"
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable --now nginx

step "6/14 yt-dlp + Chromium deps"
pip3 install --break-system-packages -U yt-dlp
apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1

step "7/14 Пользователь club + директории"
id -u club &>/dev/null || useradd -m -s /bin/bash club
install -d -o club -g club /opt/club-funnel /var/log/club-funnel /mnt/data /var/lib/ytdlp
install -d /etc/club-funnel
chown root:club /etc/club-funnel
chmod 750 /etc/club-funnel

step "8/14 .env → /etc/club-funnel/.env"
install -m 640 -o root -g club /tmp/club-funnel.env.new "$ENV_FILE"
rm -f /tmp/club-funnel.env.new

step "9/14 БД club_funnel + роли"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='club_funnel'" | grep -q 1 || {
  PG_PASS=$(grep '^PG_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  DBA_PASS=$(grep '^PG_DBA_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
  sudo -u postgres psql <<SQL
CREATE ROLE admin_dba LOGIN PASSWORD '${DBA_PASS}' CREATEDB CREATEROLE;
CREATE ROLE app_runtime LOGIN PASSWORD '${PG_PASS}';
CREATE DATABASE club_funnel OWNER admin_dba;
\c club_funnel
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
}

step "10/14 git clone / pull"
if [[ ! -d "$REPO_DIR/.git" ]]; then
  sudo -u club git clone "$REPO_URL" "$REPO_DIR"
else
  sudo -u club git -C "$REPO_DIR" fetch --all
  sudo -u club git -C "$REPO_DIR" reset --hard origin/main
fi
ln -sf "$ENV_FILE" "$REPO_DIR/.env"

step "11/14 pnpm install"
cd "$REPO_DIR"
sudo -u club -H pnpm install --frozen-lockfile

step "12/14 pnpm migrate:up"
sudo -u club -H pnpm migrate:up

step "13/14 pnpm build + pm2"
sudo -u club -H pnpm build
sudo -u club -H pm2 startOrReload ecosystem.config.cjs --update-env
sudo -u club -H pm2 save
pm2 startup systemd -u club --hp /home/club 2>/dev/null | tail -1 | bash || true

step "14/14 ufw + fail2ban"
ufw --force allow OpenSSH
ufw --force allow 80/tcp
ufw --force allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

echo
echo "✅ remote-deploy завершён. Проверь:"
echo "   - pm2 list"
echo "   - curl -sI https://agent.yury-eremin.ru/health"
REMOTE

echo
echo "=== 3. Регистрирую Telegram webhook ==="
# Имена переменных соответствуют src/config.ts (Zod schema): TG_WEBHOOK_SECRET, APP_PUBLIC_BASE_URL.
# Маршрут — src/bot/index.ts: POST /webhook/telegram (через webhookCallback grammY).
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$LOCAL_ENV_FILE" | cut -d= -f2-)
SECRET=$(grep '^TG_WEBHOOK_SECRET=' "$LOCAL_ENV_FILE" | cut -d= -f2-)
BASE_URL=$(grep '^APP_PUBLIC_BASE_URL=' "$LOCAL_ENV_FILE" | cut -d= -f2-)
WEBHOOK_URL="${BASE_URL%/}/webhook/telegram"
curl -fsS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "{\"url\":\"${WEBHOOK_URL}\",\"secret_token\":\"${SECRET}\",\"drop_pending_updates\":true}"
echo

echo
echo "=== 4. Smoke-тесты с локального Mac ==="
echo "  HTTPS:"
curl -sI --max-time 10 https://agent.yury-eremin.ru/health | head -3 || echo "  ❌ /health не отвечает"
echo

{
  echo
  echo "## $(date '+%Y-%m-%d %H:%M:%S MSK') — deploy"
  echo
  echo "- Репо: $REPO_URL"
  echo "- VPS: $(ssh -o BatchMode=yes "$VPS_HOST" hostname)"
  echo "- pm2 list:"
  ssh -o BatchMode=yes "$VPS_HOST" "sudo -u club pm2 list" | sed 's/^/  /'
} >> "$DEPLOY_LOG"

echo "✅ Deploy готов. Лог записан в $DEPLOY_LOG"
