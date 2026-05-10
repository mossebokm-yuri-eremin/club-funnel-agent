# Правила безопасности

## Критические правила (нельзя нарушать никогда)

1. **Секреты — только в .env** — API ключи, токены, пароли никогда в коде и в CLAUDE.md
2. **Claude не получает право DELETE** — пользовательские данные Claude Code может только читать/писать/обновлять
3. **Service Role Key — только на сервере** — никогда на клиенте, никогда в браузере
4. **RLS на каждой таблице** — без исключений
5. **Работать от deploy, не root** — на VPS никогда не работать под root

---

## .gitignore (обязательный минимум)

```gitignore
# Секреты
.env
.env.local
.env.*.local
*.key
credentials.json
secrets/

# Supabase
.supabase/

# OS
.DS_Store
Thumbs.db

# Node
node_modules/
.next/
dist/
build/

# Логи
*.log
npm-debug.log*
```

---

## .env файл (структура)

```env
# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# Supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...      # публичный ключ (можно на клиенте)
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # приватный (только сервер!)

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...

# GitHub (если нужен)
GITHUB_TOKEN=ghp_...

# VPS (локально, не коммитить)
VPS_HOST=123.456.78.90
```

---

## RLS политики (шаблоны)

```sql
-- SELECT: пользователь видит только свои записи
CREATE POLICY "users_select_own"
ON table_name FOR SELECT
USING (auth.uid() = user_id);

-- INSERT: пользователь может добавлять свои записи
CREATE POLICY "users_insert_own"
ON table_name FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- UPDATE: пользователь меняет только свои записи
CREATE POLICY "users_update_own"
ON table_name FOR UPDATE
USING (auth.uid() = user_id);

-- DELETE: ОСТОРОЖНО — только если действительно нужно
-- По умолчанию НЕ давать Claude право DELETE
```

---

## VPS безопасность

### После создания сервера (обязательные шаги):

```bash
# 1. Создать пользователя deploy
adduser deploy
usermod -aG sudo deploy

# 2. Перенести SSH ключ
mkdir /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh

# 3. Отключить root по паролю (КРИТИЧНО)
# В /etc/ssh/sshd_config:
PermitRootLogin no
PasswordAuthentication no

# 4. UFW firewall
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw enable

# 5. Fail2Ban (защита от брутфорса)
apt install fail2ban
systemctl enable fail2ban
```

---

## GitHub Actions безопасность

```yaml
# Секреты храни в GitHub Secrets, не в yaml:
# GitHub → Repository → Settings → Secrets and variables → Actions

# Правильно:
- name: Deploy
  env:
    SSH_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
    VPS_HOST: ${{ secrets.VPS_HOST }}

# НЕПРАВИЛЬНО (никогда так):
- name: Deploy
  run: ssh -i "МОЙ_КЛЮЧ" root@123.456.78.90
```

---

## Проверка безопасности перед деплоем

```
[ ] .env файл есть в .gitignore
[ ] Нет секретов в коде (grep -r "sk-ant" src/ должен быть пуст)
[ ] RLS включена для всех таблиц в Supabase Dashboard
[ ] Service Role Key не используется на клиенте
[ ] root-доступ по паролю отключён на VPS
[ ] UFW включён
[ ] Fail2Ban установлен
[ ] SSL сертификат активен (certbot)
[ ] GitHub Secrets настроены, не хардкод
```

---

## Российское законодательство

### 152-ФЗ (Персональные данные)
- Персональные данные граждан РФ должны храниться на серверах в России
- ФИО, email, телефон, IP-адрес = персональные данные
- Решение: VPS Beget (дата-центр в СПб)
- Политика конфиденциальности — обязательная страница на сайте

### Что не нарушает 152-ФЗ:
- Vercel без хранения ПД (чисто статика)
- CDN (CloudFlare) для статических файлов
- Аналитика без привязки к личности

### 149-ФЗ (Об информации)
- При SERM-системах — нельзя собирать и публиковать чужой контент без согласия
- Парсинг конкурентов — серая зона, консультироваться с юристом

### Реклама (38-ФЗ)
- Платный рекламный контент маркировать erid
- Нативная реклама — тоже маркировать

---

## Конфиденциальность базы знаний

Для защиты папки `agent-architect/` от чужого доступа:

```bash
# Права только для владельца
chmod -R 700 ~/Desktop/agent-architect/

# Проверить что папка не в публичном git (без --public флага)
git init
# НЕ делать: git remote add origin (публичный репозиторий)
# Делать: создать ПРИВАТНЫЙ репозиторий на GitHub
```

**GitHub приватный репозиторий:**
1. GitHub → New Repository → **Private** (не Public!)
2. `git remote add origin git@github.com:yourusername/agent-architect.git`
3. `git push -u origin main`
