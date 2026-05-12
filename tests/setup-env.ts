// Vitest setup file — выставляет stub-значения для обязательных переменных
// окружения ДО того, как тестируемые модули импортируют src/config.ts.
// Реальные секреты Юрия в .env не трогаем (CLAUDE.md §2 + правила фазы).

const stubEnv: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  YE_TG_USER_ID: '0',
  GC_WEBHOOK_SECRET: 'test-secret-1234567890',
  GC_BASE_OFFER_ID: 'test-club-offer',
  GC_ACCOUNT: 'mossebo-test',
};

for (const [k, v] of Object.entries(stubEnv)) {
  if (process.env[k] === undefined || process.env[k] === '') {
    process.env[k] = v;
  }
}
