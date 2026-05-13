#!/usr/bin/env bash
# auto-fix.sh — самовосстановление + полная диагностика app на VPS.
# Запуск: cd /opt/club-funnel && git pull && bash scripts/auto-fix.sh

set -uo pipefail
cd /opt/club-funnel || { echo "❌ /opt/club-funnel не найден"; exit 1; }

echo "================== AUTO-FIX START =================="
date

# 1. git fetch + reset на свежий main (на случай мерж-конфликтов)
echo
echo "▶ 1/8 git fetch + reset --hard origin/main"
sudo -u club git fetch origin main 2>&1 | head -5 || true
sudo -u club git reset --hard origin/main 2>&1 | tail -3 || true

# 2. Прибиваем зависший pm2-процесс
echo
echo "▶ 2/8 pm2 delete + clean restart"
sudo -u club -H pm2 delete club-funnel-agent 2>&1 | tail -2 || true

# 3. Удаляем dist полностью — чтобы tsc гарантированно пересобрал
echo
echo "▶ 3/8 rm dist/ + clean build"
sudo -u club rm -rf dist
sudo -u club -H npm run build 2>&1 | tail -3

# 4. Проверяем что фиксы попали в скомпилированный код
echo
echo "▶ 4/8 проверка фиксов в dist/"
echo "  stt-worker → ideaQueue: $(grep -c ideaQueue dist/src/jobs/stt-worker.js 2>/dev/null || echo NO_FILE)"
echo "  carousel-worker → notifyApproval: $(grep -c notifyApproval dist/src/jobs/carousel-worker.js 2>/dev/null || echo NO_FILE)"
echo "  approval-notifier exists: $(test -f dist/src/services/approval-notifier.js && echo YES || echo NO)"

# 5. Сброс retry-счётчиков застрявших jobs (Phase 4 visual / idea)
echo
echo "▶ 5/8 Redis: count jobs в очередях"
for q in audio_queue idea_queue content_queue visual_queue funnel_queue getcourse_pull_queue; do
  wait=$(redis-cli LLEN "bull:$q:wait" 2>/dev/null || echo "?")
  active=$(redis-cli LLEN "bull:$q:active" 2>/dev/null || echo "?")
  failed=$(redis-cli ZCARD "bull:$q:failed" 2>/dev/null || echo "?")
  echo "  $q: wait=$wait active=$active failed=$failed"
done

# 6. Прокидываем висящие idea (status='new') обратно в idea_queue
echo
echo "▶ 6/8 ideas со status='new' (для ручного re-enqueue):"
sudo -u postgres psql -d club_funnel -tAc "SELECT id FROM ideas WHERE status='new' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10;" 2>&1 | head -10 | while read -r idea_id; do
  [ -z "$idea_id" ] && continue
  echo "  enqueueing idea $idea_id"
  # Используем bullmq.add через node одной строкой
  sudo -u club -H node -e "
    import('/opt/club-funnel/dist/src/jobs/queues.js').then(async m => {
      const job = await m.ideaQueue().add('build', { idea_id: '$idea_id' });
      console.log('  ok jobId=' + job.id);
      await m.closeAllQueues();
      process.exit(0);
    }).catch(e => { console.error('  fail:', e.message); process.exit(1); });
  " 2>&1 | head -3 || true
done

# 7. Запускаем pm2 заново
echo
echo "▶ 7/8 pm2 start"
sudo -u club -H pm2 start ecosystem.config.cjs --update-env 2>&1 | tail -5
sleep 4
sudo -u club -H pm2 list

# 8. Свежие 30 строк логов после старта
echo
echo "▶ 8/8 логи app (последние 50 строк после старта)"
sudo -u club -H pm2 logs club-funnel-agent --lines 50 --nostream 2>&1 | tail -50

echo
echo "================== AUTO-FIX DONE =================="
date
echo
echo "Что делать дальше:"
echo "  - Запиши голосовое в @Realizacia_marketing_bot"
echo "  - Через 2-5 минут жди уведомления от бота"
echo "  - Если опять молчит → bash /opt/club-funnel/scripts/auto-fix.sh ещё раз"
