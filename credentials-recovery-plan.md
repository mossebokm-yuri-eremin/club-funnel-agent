# Credentials Recovery Plan — club-funnel-agent

Файл-чеклист: какие креды куда должны быть положены для отказоустойчивости.
Не содержит реальных значений. Реальные значения — только в `/etc/club-funnel/.env` на VPS и в защищённом менеджере паролей.

Юрий читает этот файл когда дойдут руки до организационных дел.

---

## 1. VPS-доступ

| Что | Где сейчас | Куда продублировать |
|-----|------------|---------------------|
| root password VPS Beget 62.217.179.169 | `/tmp/vps-ssh.sh` (агент) + панель Beget | Безопасный менеджер паролей |
| Tailscale auth-key (используется для SSH) | макбук агента + Tailscale account | Сам Tailscale аккаунт уже хранит ключ устройства |
| SSH ed25519 публичный ключ (пока НЕ развёрнут) | — | После генерации: `~/.ssh/club_funnel_ed25519.pub` на Mac + добавить в `~/.ssh/authorized_keys` на VPS |

## 2. Содержимое `/etc/club-funnel/.env`

Полная копия .env требуется для:
- быстрого восстановления при потере VPS
- передачи прав сотруднику / себе на новом устройстве

Ключевые поля (имена только, без значений):
- `DATABASE_URL` (PostgreSQL DSN)
- `REDIS_URL`
- `TELEGRAM_BOT_TOKEN`
- `TG_WEBHOOK_SECRET`
- `YE_TG_USER_ID`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `DEEPGRAM_API_KEY`
- `GEMINI_API_KEY`
- `CLOUDINARY_URL`
- `GC_API_TOKEN` (когда появится)
- `GC_WEBHOOK_SECRET`
- `CHATPLACE_API_KEY` (когда появится)
- env-флаги обхода:
  - `STRATEGY_COLD_START_FALLBACK_B=true`
  - `NANO_BANANA_PLACEHOLDER_MODE=true`
  - `GC_PULL_DISABLED=true`

Куда положить: безопасный менеджер паролей (Bitwarden / 1Password / etc) — отдельная запись с приложенным `.env` файлом, **без логина-пароля внутри текста** (только сам файл).

## 3. GitHub PAT

Текущий PAT в helper-скриптах + git remote на VPS. При истечении — пересоздать через GitHub Settings → Developer settings → Personal access tokens (classic), scopes: `repo`.

## 4. Восстановление при потере VPS (DR)

Минимальный набор для разворота на новом VPS:
1. Клонировать репо `mossebokm-yuri-eremin/club-funnel-agent` (нужен PAT).
2. Восстановить `.env` из менеджера паролей.
3. Прогон миграций: `psql -f migrations/001_initial.sql … 002_seed_voices.sql`.
4. `npm install && npm run build && pm2 start ecosystem.config.cjs`.
5. Восстановить `/var/log/club-funnel/` (не критично, но логи теряются).

## 5. Что НЕ надо хранить в менеджере паролей

- Файлы `dist/` и `node_modules/` — генерируются.
- Файлы `bull*` ключей Redis — runtime state.
- `wiki/` и `raw/` — отдельный git-репозиторий «ИИ агент».
