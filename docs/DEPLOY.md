# DEPLOY — где живёт прод и как обновлять

## Прод

- **VPS:** Beget, `62.217.179.169` (public), Ubuntu 24.04
- **Tailscale Mesh:** `100.114.102.75` (для приватного SSH)
- **Домен:** `https://agent.yury-eremin.ru` → nginx → Fastify localhost:3000
- **Пользователь:** `club` (UID не-root)
- **Каталог:** `/opt/club-funnel/`
- **PM2:** `club-funnel-agent` (fork mode, single process)
- **Логи:** `/var/log/club-funnel/{out,err}.log` + ежедневная ротация `pm2-logrotate`
- **БД:** PostgreSQL `club_funnel`, owner `app_runtime`, password в `/etc/club-funnel/.env`
- **Redis:** localhost:6379 (no password)
- **nginx config:** `/etc/nginx/sites-enabled/agent.yury-eremin.ru`

## Стандартный цикл обновления

```bash
# Локально:
git add -A && git commit -m "..." && git push origin main

# На VPS:
ssh club-funnel-vps
cd /opt/club-funnel
git pull origin main
sudo -u club -H npm run build
sudo -u club -H pm2 restart club-funnel-agent --update-env
curl -s http://127.0.0.1:3000/health
sudo -u club pm2 logs club-funnel-agent --lines 30 --nostream
```

## Прямое редактирование на VPS

Если не хочется делать круг через GitHub:

```bash
ssh club-funnel-vps
# vim или python-патчинг ../src/...
cd /opt/club-funnel
sudo -u club -H npm run build
sudo -u club -H pm2 restart club-funnel-agent --update-env
# commit + push с VPS, чтобы локально потом подтянуть
git -c user.name="club-bot" -c user.email="club-bot@yury-eremin.ru" \
    commit -am "..."
git push origin main
```

## /etc/club-funnel/.env vs /opt/club-funnel/.env

- `/etc/club-funnel/.env` — каноничный env (живой), приватный (0600, owner club)
- `/opt/club-funnel/.env` — реплика для процесса (читается dotenv при старте)

При апдейте env: править `/etc/club-funnel/.env`, потом `cp` в `/opt/club-funnel/.env`.

## Откат

```bash
ssh club-funnel-vps
cd /opt/club-funnel
git log --oneline -5
git revert <bad-commit>  # создаёт новый коммит с инверсией
sudo -u club -H npm run build
sudo -u club -H pm2 restart club-funnel-agent --update-env
git push origin main
```

## Health checks

| Endpoint | Что проверяет |
|---|---|
| `GET /health` | Базовое liveness (200 ok) |
| `GET /admin/billing` | Расходы по image_generations (защищено bearer) |
| `GET /webhook/telegram` | Должен 405 для GET (только POST) |
| `POST /webhook/getcourse` | HMAC-валидация секретом |

## Расходы

- ~$0.20 за полный content_package (reel+tg_post+carousel+rz_post)
- ~8 ₽/слайд если генерация картинок через Seedream
- Alerts: > 500 ₽/сутки → TG-уведомление через `billing-alert-worker`

## Прод-секреты (где лежат)

- Bitwarden collection "MOSSEBO Production" — каноничный store
- `/etc/club-funnel/.env` — копия на VPS
- `/etc/club-funnel/gdrive-service-account.json` — Google Drive

⚠️ Известные проблемы (security backlog):
- GitHub PAT в `git remote -v` — нужна ротация
- `CHATPLACE_API_KEY=cpk_3e14c14c…` в `scripts/deploy-vnc.md` — нужна ротация
- `/var/backups/postgresql/` не настроен ежедневный pg_dump
