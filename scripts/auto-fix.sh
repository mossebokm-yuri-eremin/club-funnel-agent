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

# 3. Удаляем dist полностью + tsbuildinfo + npm cache — чтобы tsc гарантированно пересобрал
echo
echo "▶ 3/8 rm dist/ + clean build (с явной проверкой)"
sudo -u club rm -rf dist node_modules/.cache *.tsbuildinfo .tsbuildinfo 2>/dev/null || true
sudo -u club -H npm run build 2>&1 | tee /tmp/build.log | tail -10
echo
if [ ! -f dist/src/jobs/stt-worker.js ]; then
  echo "❌ BUILD FAILED — dist/src/jobs/stt-worker.js не создан. Содержимое /tmp/build.log:"
  tail -30 /tmp/build.log
  echo "Прерываюсь."
  exit 1
fi
# Дополнительная страховка: если фикс не попал в скомпилированный файл — форсим tsc -b --force
if ! grep -q "about to enqueue" dist/src/jobs/stt-worker.js; then
  echo "⚠ stt-worker.js скомпилирован, но фикс не виден — форсим tsc -b --force"
  sudo -u club rm -rf dist
  sudo -u club -H npx tsc -p tsconfig.build.json --force 2>&1 | tail -10
fi

# 4. Проверяем что фиксы попали в скомпилированный код
echo
echo "▶ 4/8 проверка фиксов в dist/"
echo "  stt-worker → ideaQueue: $(grep -c ideaQueue dist/src/jobs/stt-worker.js 2>/dev/null || echo NO_FILE)"
echo "  carousel-worker → notifyApproval: $(grep -c notifyApproval dist/src/jobs/carousel-worker.js 2>/dev/null || echo NO_FILE)"
echo "  approval-notifier exists: $(test -f dist/src/services/approval-notifier.js && echo YES || echo NO)"

# 5. Полная очистка idea_queue от мусора + Redis status
echo
echo "▶ 5/8 Очистка idea_queue от старых мусорных jobs"
redis-cli DEL bull:idea_queue:wait bull:idea_queue:active bull:idea_queue:failed bull:idea_queue:delayed bull:idea_queue:paused bull:idea_queue:meta-paused bull:idea_queue:id bull:idea_queue:stalled-check 2>&1 | head -5 || true
echo "  Redis: count jobs во всех очередях"
for q in audio_queue idea_queue content_queue visual_queue funnel_queue getcourse_pull_queue; do
  wait=$(redis-cli LLEN "bull:$q:wait" 2>/dev/null || echo "?")
  active=$(redis-cli LLEN "bull:$q:active" 2>/dev/null || echo "?")
  failed=$(redis-cli ZCARD "bull:$q:failed" 2>/dev/null || echo "?")
  echo "  $q: wait=$wait active=$active failed=$failed"
done

# 6. Прокидываем висящие idea (status='new') обратно в idea_queue
# ВАЖНО: у таблицы ideas НЕТ колонки deleted_at — фильтруем только по status.
echo
echo "▶ 6/8 ideas со status='new' (для ручного re-enqueue):"
NEW_IDS=$(sudo -u postgres psql -d club_funnel -tAc "SELECT id FROM ideas WHERE status='new' ORDER BY created_at DESC LIMIT 10;" 2>/dev/null | tr -d ' ')
if [ -z "$NEW_IDS" ]; then
  echo "  нет idea со status='new'"
else
  for idea_id in $NEW_IDS; do
    # UUID — 36 символов; проверим формат на всякий случай.
    if [[ ! "$idea_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
      echo "  skip (not a UUID): $idea_id"
      continue
    fi
    echo "  enqueueing idea $idea_id"
    sudo -u club -H node -e "
      import('/opt/club-funnel/dist/src/jobs/queues.js').then(async m => {
        const job = await m.ideaQueue().add('build', { idea_id: '$idea_id' }, { jobId: 'manual:$idea_id' });
        console.log('    ok jobId=' + job.id);
        await m.closeAllQueues();
        process.exit(0);
      }).catch(e => { console.error('    fail:', e.message); process.exit(1); });
    " 2>&1 | head -3 || true
  done
fi

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
