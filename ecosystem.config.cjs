// pm2 ecosystem — единственный процесс приложения.
// Один процесс держит: Fastify HTTP server (webhook GetCourse + /health),
// Telegram bot (grammY webhook), все 6 BullMQ-воркеров и cron gc-pull.
// Если нагрузка вырастет — выделить воркеры в отдельные apps; пока для MVP — один процесс.
module.exports = {
  apps: [
    {
      name: 'club-funnel-agent',
      script: 'dist/src/index.js',
      cwd: '/opt/club-funnel',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // 6 воркеров + grammY + LLM SDK + лёгкий Puppeteer на render-job → 512M узко.
      // Поднял до 1024M; при росте нагрузки выделим воркеры в отдельные apps.
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'production',
        // VPS Beget (РФ): Node global fetch уходит в IPv6 → ETIMEDOUT к api.telegram.org
        // (curl через IPv4 работает). Заставляем DNS возвращать IPv4 первым —
        // approval-notifier перестаёт падать `fetch failed (non-fatal)`.
        NODE_OPTIONS: '--dns-result-order=ipv4first',
      },
      env_file: '/etc/club-funnel/.env',
      out_file: '/var/log/club-funnel/out.log',
      error_file: '/var/log/club-funnel/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
