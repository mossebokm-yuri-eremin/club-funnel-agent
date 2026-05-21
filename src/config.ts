import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

const intNum = z.coerce.number().int();
const floatNum = z.coerce.number();

const ConfigSchema = z.object({
  // --- Environment ---
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME: z.string().default('club-funnel-agent'),
  APP_HOST: z.string().default('0.0.0.0'),
  APP_PORT: intNum.default(3000),
  APP_PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  TZ: z.string().default('Europe/Moscow'),

  // --- Postgres ---
  PG_HOST: z.string().default('127.0.0.1'),
  PG_PORT: intNum.default(5432),
  PG_DATABASE: z.string().default('club_funnel'),
  PG_USER: z.string().default('app_runtime'),
  PG_PASSWORD: z.string().default(''),
  PG_SSL: boolish.default(false),
  PG_POOL_MAX: intNum.default(20),
  PG_DBA_USER: z.string().optional(),
  PG_DBA_PASSWORD: z.string().optional(),

  // --- Redis ---
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: intNum.default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),
  REDIS_DB: intNum.default(0),

  // --- Anthropic ---
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY required'),
  ANTHROPIC_MODEL_GENERATIVE: z.string().default('claude-sonnet-4-6'),
  ANTHROPIC_MODEL_THINKING: z.string().default('claude-opus-4-7'),
  ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_THINKING_BUDGET_TOKENS: intNum.default(32000),

  // --- Google AI ---
  GEMINI_API_KEY: z.string().optional(),
  /** GPTunnel Creative Lab — российский провайдер (seedream-4 / flux / imagine). */
  GPTUNNEL_API_KEY: z.string().optional(),
  /** Какой провайдер использовать для генерации картинок каруселей.
   *  'gptunnel' (default) — seedream-4 через российский агрегатор (8₽/картинка).
   *  'gemini' — Nano Banana через прокси (если будет настроен billing).
   *  'placeholder' — серый PNG (smoke / без AI).
   *  'template' — SVG-шаблоны без AI-картинок (CAROUSEL_USE_TEMPLATES). */
  IMAGE_PROVIDER: z.enum(['gptunnel', 'gemini', 'placeholder', 'template']).default('gptunnel'),
  /** Порог суточного расхода (в копейках), при превышении — TG-алерт Юрию.
   *  Default 50000 копеек = 500₽ (как Юрий просил). */
  BILLING_DAILY_ALERT_KOPECKS: z
    .string()
    .default('50000')
    .transform((v) => parseInt(v, 10) || 50000),
  /**
   * HTTPS-прокси для запросов к Gemini API (РФ-VPS → Netherlands прокси).
   * Формат: `http://login:pass@host:port`. Пусто = без прокси (для локального dev).
   * Используется ТОЛЬКО для generativelanguage.googleapis.com.
   */
  GEMINI_HTTPS_PROXY: z.string().optional(),
  /** Bearer-токен для POST /test/image-gen (диагностический endpoint, не для прод). */
  TEST_ENDPOINT_TOKEN: z.string().optional(),
  GEMINI_VIDEO_MODEL: z.string().default('gemini-2.5-pro'),
  GEMINI_IMAGE_MODEL: z.string().default('gemini-3-pro-image'),
  /** При true генерирует placeholder PNG вместо вызова Gemini API (для smoke/dev, обход геоблока). */
  NANO_BANANA_PLACEHOLDER_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * При true рендерим карусели из SVG-шаблонов MOSSEBO (assets/carousel-templates/)
   * вместо AI-картинок Nano Banana. Подходит когда:
   *   • Gemini billing pending, ИЛИ
   *   • хочется быстрых брендированных слайдов без расходов на AI.
   * Если флаг не задан, шаблоны используются автоматически когда включён PLACEHOLDER_MODE.
   */
  CAROUSEL_USE_TEMPLATES: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /**
   * TTL кэша SVG-шаблонов каруселей (секунды). После истечения agent перечитывает
   * шаблоны из GDrive (если GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID задан).
   * Default 300с = 5 мин. /refresh_templates сбрасывает кэш вручную.
   */
  CAROUSEL_TEMPLATES_TTL_S: intNum.default(300),

  // --- Deepgram ---
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().default('nova-3'),
  DEEPGRAM_LANGUAGE: z.string().default('ru'),

  // --- Embeddings ---
  // 'gptunnel' (default) — российский агрегатор, оплата ₽, OpenAI-compatible API.
  // 'openai'  — прямой OpenAI (нужна иностранная карта).
  // 'anthropic' — зарезервировано на будущее.
  EMBEDDING_PROVIDER: z.enum(['gptunnel', 'openai', 'anthropic']).default('gptunnel'),
  OPENAI_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIM: intNum.default(1536),
  /** GPTunnel embeddings endpoint base. Тот же GPTUNNEL_API_KEY что и для картинок. */
  GPTUNNEL_EMBEDDING_BASE_URL: z.string().url().default('https://gptunnel.ru/v1'),
  GPTUNNEL_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  /** Включить ли fallback на прямой OpenAI, если GPTunnel вернул ошибку.
   *  Имеет смысл только если есть валидный OPENAI_API_KEY. */
  EMBEDDING_OPENAI_FALLBACK: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN required'),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  YE_TG_USER_ID: intNum,
  ANNA_TG_CHAT_ID: intNum.optional(),
  TG_WEBHOOK_SECRET: z.string().optional(),

  // --- Instagram Graph ---
  IG_USER_ID: z.string().optional(),
  IG_PAGE_ACCESS_TOKEN: z.string().optional(),
  IG_APP_SECRET: z.string().optional(),
  IG_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  YE_IG_USERNAME: z.string().optional(),
  IG_COOKIES_PATH: z.string().optional(),

  // --- ChatPlace ---
  CHATPLACE_API_BASE: z.string().url().default('https://api.chatplace.io/v1'),
  CHATPLACE_API_KEY: z.string().optional(),
  CHATPLACE_WEBHOOK_TOKEN: z.string().optional(),
  /** UUID Instagram-бота в ChatPlace (узнать через MCP bots_list, один раз). */
  CHATPLACE_IG_BOT_ID: z.string().optional(),
  /** Override URL MCP-сервера (по умолчанию https://mcp.chatplace.io/mcp). */
  CHATPLACE_MCP_URL: z.string().url().optional(),

  // --- GetCourse ---
  GC_ACCOUNT: z.string().optional(),
  GC_API_KEY: z.string().optional(),
  GC_WEBHOOK_SECRET: z.string().min(1, 'GC_WEBHOOK_SECRET required for HMAC validation'),
  GC_BASE_OFFER_ID: z.string().optional(),
  GC_BASE_PRICE_KOPECKS: intNum.default(500000),
  GC_API_BASE: z.string().url().default('https://account.getcourse.ru/pl/api'),
  GC_PULL_PAGE_SIZE: intNum.default(100),
  /** Полностью отключает getcourse_pull_queue воркер и cron (до получения корректных GC API кредов). */
  GC_PULL_DISABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // --- Cloudinary ---
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_FOLDER: z.string().default('club-funnel'),
  CLOUDINARY_FALLBACK_LOCAL_DIR: z.string().default('/var/www/cdn'),

  // --- Google Drive ---
  GDRIVE_SERVICE_ACCOUNT_JSON_PATH: z.string().optional(),
  GDRIVE_LONGREADS_FOLDER_ID: z.string().optional(),
  GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID: z.string().optional(),
  GDRIVE_YE_PHOTO_FILE_ID: z.string().optional(),

  // --- RapidAPI fallback ---
  RAPIDAPI_KEY: z.string().optional(),
  RAPIDAPI_IG_HOST: z.string().default('instagram-downloader.p.rapidapi.com'),

  // --- GitHub (knowledge base source) ---
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_KNOWLEDGE_REPO: z.string().optional(),
  GITHUB_KNOWLEDGE_BRANCH: z.string().default('main'),
  GITHUB_KNOWLEDGE_PATH: z.string().default('knowledge'),

  // --- File storage ---
  DATA_DIR: z.string().default('/mnt/data'),
  REFS_DIR: z.string().default('/mnt/data/refs'),
  PDF_TMP_DIR: z.string().default('/mnt/data/tmp/pdf'),

  // --- Thresholds ---
  VOICE_VALIDATOR_MIN_DENSITY: floatNum.default(0.3),
  VOICE_VALIDATOR_MAX_RETRIES: intNum.default(3),
  STRATEGY_A_MIN_SIMILARITY: floatNum.default(0.85),
  STRATEGY_C_MAX_SIMILARITY: floatNum.default(0.65),
  STRATEGY_B_PERIOD_IDEAS: intNum.default(10),
  /** При cold start (bonus_library пустая) выбирать B (быстрая карусель) вместо C. */
  STRATEGY_COLD_START_FALLBACK_B: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  LONGREAD_MIN_WORDS: intNum.default(1500),
  LONGREAD_MAX_WORDS: intNum.default(2500),
  BONUS_CR_DROP_THRESHOLD_PCT: floatNum.default(30),
  WARMUP_LONG_TAIL_WEEKS: intNum.default(8),
  INFERENCE_BUDGET_TOKENS_DAILY: intNum.default(8000000),

  // --- Observability ---
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: boolish.default(false),
  LOG_REDACT_PD: boolish.default(true),
  PROMETHEUS_PORT: intNum.default(9090),
  LOKI_ENDPOINT: z.string().optional().default(''),

  // --- Cron ---
  CRON_GC_RECONCILE: z.string().default('0 * * * *'),
  CRON_BONUS_CR_AUDIT: z.string().default('15 3 * * *'),
  CRON_REFS_CROSSCHECK: z.string().default('30 4 * * *'),
  CRON_WEEKLY_REPORT: z.string().default('0 10 * * 6'),
  CRON_IG_TOKEN_REFRESH: z.string().default('0 2 1 * *'),
  CRON_REFERENCES_NUDGE: z.string().default('0 9 * * *'),

  // --- Dev flags ---
  DEV_BYPASS_VOICE_VALIDATOR: boolish.default(false),
  DEV_DRY_RUN_CHATPLACE: boolish.default(false),
  DEV_DRY_RUN_GETCOURSE: boolish.default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function load(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration. Fix .env:\n${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DEV_BYPASS_VOICE_VALIDATOR) {
    throw new Error('DEV_BYPASS_VOICE_VALIDATOR=true is forbidden in production');
  }
  return parsed.data;
}

export const config: Config = load();
