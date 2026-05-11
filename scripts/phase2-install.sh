#!/bin/bash
# club-funnel-agent — Phase 2: полная установка инфраструктуры на чистом Ubuntu 24.04 LTS
# Запускается от root после успешного входа по SSH-ключу.
# Идемпотентен — можно прогонять повторно.

set -euo pipefail
LOG=/root/cf-setup/phase2.log
mkdir -p /root/cf-setup
exec > >(tee -a "$LOG") 2>&1
echo "=== phase 2 START $(date -u +%FT%TZ) ==="

#------------------------------------------------------------------------------
# 0. Базовые проверки
#------------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then echo "Run as root"; exit 1; fi
if ! grep -q "Ubuntu 24" /etc/os-release; then echo "Not Ubuntu 24.x"; exit 1; fi

export DEBIAN_FRONTEND=noninteractive

#------------------------------------------------------------------------------
# 1. apt update + базовые пакеты
#------------------------------------------------------------------------------
echo "--- [1/9] apt update + base packages ---"
apt-get update -y
apt-get -y upgrade
apt-get install -y \
  build-essential curl wget git ca-certificates gnupg lsb-release \
  software-properties-common apt-transport-https \
  ufw fail2ban \
  nginx \
  redis-server \
  python3-pip python3-venv \
  ffmpeg \
  fonts-inter \
  jq unzip zip rsync htop net-tools dnsutils

#------------------------------------------------------------------------------
# 2. Node.js 22 LTS + pnpm + pm2
#------------------------------------------------------------------------------
echo "--- [2/9] Node.js 22 LTS ---"
if ! node --version 2>/dev/null | grep -qE '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version
npm --version
npm install -g pnpm pm2
pnpm --version
pm2 --version

#------------------------------------------------------------------------------
# 3. PostgreSQL 16 + pgvector
#------------------------------------------------------------------------------
echo "--- [3/9] PostgreSQL 16 + pgvector ---"
# PostgreSQL 16 нет в стандартном Ubuntu 24.04 (там 16 уже), но добавим PGDG для надёжности
if ! psql --version 2>/dev/null | grep -q "16\."; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  sh -c 'echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
  apt-get update -y
  apt-get install -y postgresql-16 postgresql-contrib-16
fi

# pgvector
apt-get install -y postgresql-16-pgvector || apt-get install -y postgresql-16-pgvector-15 || true

systemctl enable --now postgresql
psql --version
sudo -u postgres psql -c "SELECT version();" | head -3

#------------------------------------------------------------------------------
# 4. yt-dlp
#------------------------------------------------------------------------------
echo "--- [4/9] yt-dlp ---"
pip3 install --break-system-packages -U yt-dlp || pip3 install -U yt-dlp
yt-dlp --version

#------------------------------------------------------------------------------
# 5. Puppeteer / Chromium dependencies
#------------------------------------------------------------------------------
echo "--- [5/9] Chromium deps for Puppeteer ---"
apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
  libcairo2 libasound2t64

#------------------------------------------------------------------------------
# 6. Пользователь club + директории
#------------------------------------------------------------------------------
echo "--- [6/9] user 'club' + dirs ---"
if ! id -u club >/dev/null 2>&1; then
  useradd -r -m -s /bin/bash club
fi
mkdir -p /etc/club-funnel /var/log/club-funnel /mnt/data/refs /mnt/data/tmp/pdf /var/lib/ytdlp /var/www/cdn /home/club/app
chown -R club:club /var/log/club-funnel /mnt/data /var/lib/ytdlp /var/www/cdn /home/club/app
chmod 750 /etc/club-funnel
chown root:club /etc/club-funnel

#------------------------------------------------------------------------------
# 7. ufw + fail2ban hardening
#------------------------------------------------------------------------------
echo "--- [7/9] firewall ---"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
ufw status verbose

systemctl enable --now fail2ban

#------------------------------------------------------------------------------
# 8. БД + роли PostgreSQL
#------------------------------------------------------------------------------
echo "--- [8/9] PostgreSQL DB + roles ---"
# Пароли генерируем и сохраним в /etc/club-funnel/pg-passwords.env (chmod 600 root)
PG_DBA_PW=$(openssl rand -base64 32 | tr -d /=+ | cut -c1-28)
PG_APP_PW=$(openssl rand -base64 32 | tr -d /=+ | cut -c1-28)

sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='admin_dba') THEN
    CREATE ROLE admin_dba WITH LOGIN SUPERUSER PASSWORD '${PG_DBA_PW}';
  ELSE
    ALTER ROLE admin_dba WITH PASSWORD '${PG_DBA_PW}';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='app_runtime') THEN
    CREATE ROLE app_runtime WITH LOGIN PASSWORD '${PG_APP_PW}';
  ELSE
    ALTER ROLE app_runtime WITH PASSWORD '${PG_APP_PW}';
  END IF;
END
\$\$;

SELECT 'roles done';
SQL

sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='club_funnel'" | grep -q 1 || \
  sudo -u postgres createdb -O admin_dba club_funnel

sudo -u postgres psql -d club_funnel -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d club_funnel -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
sudo -u postgres psql -d club_funnel -c "CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

cat > /etc/club-funnel/pg-passwords.env <<EOF
PG_DBA_USER=admin_dba
PG_DBA_PASSWORD=${PG_DBA_PW}
PG_USER=app_runtime
PG_PASSWORD=${PG_APP_PW}
PG_DATABASE=club_funnel
PG_HOST=127.0.0.1
PG_PORT=5432
EOF
chmod 600 /etc/club-funnel/pg-passwords.env
chown root:root /etc/club-funnel/pg-passwords.env

#------------------------------------------------------------------------------
# 9. nginx базовый stub (без TLS — до настройки DNS)
#------------------------------------------------------------------------------
echo "--- [9/9] nginx stub ---"
cat > /etc/nginx/sites-available/club-funnel-stub <<'NGINX'
server {
  listen 80 default_server;
  server_name _;
  location /healthz { return 200 "ok\n"; add_header Content-Type text/plain; }
  location / { return 503 "club-funnel: not deployed yet\n"; add_header Content-Type text/plain; }
}
NGINX
ln -sf /etc/nginx/sites-available/club-funnel-stub /etc/nginx/sites-enabled/club-funnel-stub
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

#------------------------------------------------------------------------------
# Финальная сводка
#------------------------------------------------------------------------------
echo ""
echo "=== phase 2 SUMMARY ==="
echo "Node:        $(node --version)"
echo "pnpm:        $(pnpm --version)"
echo "pm2:         $(pm2 --version)"
echo "PostgreSQL:  $(psql --version)"
echo "  pgvector:  $(sudo -u postgres psql -d club_funnel -tAc "SELECT extversion FROM pg_extension WHERE extname='vector'")"
echo "Redis:       $(redis-cli --version)"
echo "nginx:       $(nginx -v 2>&1)"
echo "yt-dlp:      $(yt-dlp --version)"
echo "ufw:         $(ufw status | head -1)"
echo "fail2ban:    $(systemctl is-active fail2ban)"
echo ""
echo "DB:          club_funnel (owned by admin_dba)"
echo "Roles:       admin_dba (SUPERUSER), app_runtime"
echo "Passwords:   /etc/club-funnel/pg-passwords.env (root:600)"
echo ""
echo "=== phase 2 DONE $(date -u +%FT%TZ) ==="
