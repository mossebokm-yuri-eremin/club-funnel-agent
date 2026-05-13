#!/usr/bin/env bash
# inventory.sh — READ-ONLY инвентаризация VPS для аудита.
# Никаких изменений на сервере. Только чтение.
# Сохраняет результат в /tmp/inventory.txt.

OUT=/tmp/inventory.txt
exec > "$OUT" 2>&1

print_section() {
  echo
  echo "═══════════════════════════════════════════════════════════"
  echo "▶ $1"
  echo "═══════════════════════════════════════════════════════════"
}

echo "INVENTORY — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "host: $(hostname)"
echo "uptime: $(uptime)"

print_section "1. PM2 list"
sudo -u club -H pm2 list 2>&1

print_section "1.1 PM2 describe club-funnel-agent"
sudo -u club -H pm2 describe club-funnel-agent 2>&1 | head -80

print_section "1.2 PM2 stdout (последние 500 строк)"
sudo -u club -H pm2 logs club-funnel-agent --lines 500 --nostream --out 2>&1 | tail -500

print_section "1.3 PM2 stderr (последние 500 строк)"
sudo -u club -H pm2 logs club-funnel-agent --lines 500 --nostream --err 2>&1 | tail -500

print_section "2. PostgreSQL: список таблиц"
sudo -u postgres psql -d club_funnel -c "\dt" 2>&1

print_section "2.1 migrations"
sudo -u postgres psql -d club_funnel -c "SELECT * FROM schema_migrations ORDER BY version;" 2>&1

print_section "2.2 row counts"
for t in ideas content_packages bonus_library subscribers funnel_events references_inbox voices; do
  echo "--- $t ---"
  sudo -u postgres psql -d club_funnel -c "SELECT COUNT(*) FROM $t;" 2>&1 | head -5
done

print_section "2.3 последние 10 ideas (id, status, source, raw_transcript[:60])"
sudo -u postgres psql -d club_funnel -c "SELECT id, status, source, LEFT(raw_transcript, 60) as transcript FROM ideas ORDER BY created_at DESC LIMIT 10;" 2>&1

print_section "2.4 последние 5 content_packages"
sudo -u postgres psql -d club_funnel -c "SELECT id, idea_id, voice_code, approval_status, created_at FROM content_packages ORDER BY created_at DESC LIMIT 5;" 2>&1

print_section "3. Redis: BullMQ очереди"
for q in audio_queue reference_dl_queue reference_process_queue idea_queue content_queue visual_queue funnel_queue getcourse_pull_queue; do
  wait=$(redis-cli LLEN "bull:$q:wait" 2>/dev/null || echo "?")
  active=$(redis-cli LLEN "bull:$q:active" 2>/dev/null || echo "?")
  delayed=$(redis-cli ZCARD "bull:$q:delayed" 2>/dev/null || echo "?")
  failed=$(redis-cli ZCARD "bull:$q:failed" 2>/dev/null || echo "?")
  completed=$(redis-cli ZCARD "bull:$q:completed" 2>/dev/null || echo "?")
  echo "  $q: wait=$wait active=$active delayed=$delayed failed=$failed completed=$completed"
done

print_section "3.1 Redis: failed jobs (первые 20 ключей)"
redis-cli KEYS "bull:*:failed" 2>&1 | head -20

print_section "3.2 Redis: образец failed job idea_queue (если есть)"
FAILED_IDS=$(redis-cli ZRANGE bull:idea_queue:failed 0 5 2>/dev/null)
if [ -n "$FAILED_IDS" ]; then
  echo "  failed job ids: $FAILED_IDS"
  for fid in $FAILED_IDS; do
    echo "--- job $fid ---"
    redis-cli HGETALL "bull:idea_queue:$fid" 2>&1 | head -20
  done
else
  echo "  нет failed jobs в idea_queue"
fi

print_section "4. Telegram getWebhookInfo"
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /etc/club-funnel/.env | cut -d= -f2-)
if [ -n "$TOKEN" ]; then
  curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" 2>&1 | head -30
else
  echo "  TELEGRAM_BOT_TOKEN не найден в /etc/club-funnel/.env"
fi

print_section "5. nginx config для agent.yury-eremin.ru"
nginx -T 2>/dev/null | awk '/server_name agent\.yury-eremin\.ru/,/^}/' | head -60

print_section "5.1 nginx последние ошибки"
journalctl -u nginx -n 30 --no-pager 2>&1 | grep -i error | head -20

print_section "5.2 системные сервисы (active/inactive)"
for svc in nginx postgresql redis-server fail2ban ufw pm2-club; do
  echo "  $svc: $(systemctl is-active $svc 2>&1) / enabled: $(systemctl is-enabled $svc 2>&1)"
done

print_section "6. .env keys (только имена, без значений)"
if [ -r /etc/club-funnel/.env ]; then
  grep -E '^[A-Z_]+=' /etc/club-funnel/.env | cut -d= -f1 | sort
  echo "---"
  echo "Заполненность (заполнено = есть значение, изменено = не changeme/__FILL):"
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    if [ -z "$val" ]; then echo "  [пусто]    $key"
    elif [[ "$val" == "changeme"* || "$val" == "__FILL"* || "$val" == "__FROM"* ]]; then echo "  [плейсхолдер] $key"
    else echo "  [ok]       $key"
    fi
  done < <(grep -E '^[A-Z_]+=' /etc/club-funnel/.env)
else
  echo "  /etc/club-funnel/.env не читается (permissions?)"
fi

print_section "7. git состояние"
cd /opt/club-funnel
sudo -u club git log --oneline -10 2>&1
echo "---status---"
sudo -u club git status 2>&1 | head -10
echo "---remote---"
sudo -u club git remote -v 2>&1 | sed 's/ghp_[A-Za-z0-9_]*/ghp_***REDACTED***/g'

print_section "8. версии стека"
node --version 2>&1
echo "npm:  $(npm --version 2>&1)"
echo "pnpm: $(pnpm --version 2>&1)"
echo "pm2:  $(sudo -u club -H pm2 --version 2>&1)"
psql --version 2>&1
redis-server --version 2>&1
nginx -v 2>&1
echo "yt-dlp: $(yt-dlp --version 2>&1 | head -1)"

print_section "9. ресурсы VPS"
df -h /
echo "---"
free -h
echo "---"
echo "load: $(cat /proc/loadavg)"

print_section "10. UFW + fail2ban"
ufw status 2>&1 | head -20
echo "---fail2ban---"
fail2ban-client status 2>&1 | head -10

print_section "11. dist/ — что скомпилировано"
ls -la /opt/club-funnel/dist/src/jobs/ 2>&1 | head -20
echo "---"
echo "ключевые фиксы (grep по dist):"
echo "  stt-worker → ideaQueue: $(grep -c 'ideaQueue\|about to enqueue' /opt/club-funnel/dist/src/jobs/stt-worker.js 2>/dev/null || echo NO_FILE)"
echo "  carousel-worker → notifyApproval: $(grep -c 'notifyApproval' /opt/club-funnel/dist/src/jobs/carousel-worker.js 2>/dev/null || echo NO_FILE)"
echo "  approval-notifier.js: $(test -f /opt/club-funnel/dist/src/services/approval-notifier.js && echo YES || echo NO)"

echo
echo "═══════════════════════════════════════════════════════════"
echo "INVENTORY DONE — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Файл: $OUT"
echo "Размер: $(wc -c < $OUT) байт"
echo "═══════════════════════════════════════════════════════════"
