# ENV переменные club-funnel-agent

Каноничный source — `/etc/club-funnel/.env` на VPS (0600, owner club).
Локально — `~/Desktop/club-funnel-agent/.env` (gitignored).

## App / База

| Переменная | Что |
|---|---|
| `NODE_ENV` | `production` на VPS, `development` локально |
| `APP_NAME` | `club-funnel-agent` |
| `APP_HOST` | `0.0.0.0` на VPS |
| `APP_PORT` | `3000` |
| `APP_PUBLIC_BASE_URL` | `https://agent.yury-eremin.ru` |
| `TZ` | `Europe/Moscow` |

## PostgreSQL

| `PG_HOST` `PG_PORT` `PG_DATABASE` `PG_USER` `PG_PASSWORD` `PG_SSL` `PG_POOL_MAX` |
| `PG_DBA_USER` `PG_DBA_PASSWORD` (для миграций) |

## Redis

| `REDIS_HOST` `REDIS_PORT` `REDIS_PASSWORD` `REDIS_DB` |

## Anthropic

| `ANTHROPIC_API_KEY` |
| `ANTHROPIC_MODEL_GENERATIVE` = `claude-sonnet-4-6` |
| `ANTHROPIC_MODEL_THINKING` = `claude-opus-4-7` (Opus для рассуждений) |
| `ANTHROPIC_MODEL_FAST` = `claude-haiku-4-5-20251001` |
| `ANTHROPIC_THINKING_BUDGET_TOKENS` = `32000` |

## Telegram Bot

| `TELEGRAM_BOT_TOKEN` |
| `TELEGRAM_BOT_USERNAME` = `Realizacia_marketing_bot` |
| `TG_WEBHOOK_SECRET` — X-Telegram-Bot-Api-Secret-Token |
| **`YE_TG_USER_ID`** = `298854277` — основной allowlist user_id Юрия |
| **`YE_TG_USER_IDS`** — CSV дополнительных user_id (мобильный/планшет/тестеры) |
| `ANNA_TG_CHAT_ID` — chat_id Анны (для send media) |

## Instagram Graph

| `IG_USER_ID` `IG_PAGE_ACCESS_TOKEN` `IG_APP_SECRET` `IG_WEBHOOK_VERIFY_TOKEN` |
| `YE_IG_USERNAME` `IG_COOKIES_PATH` (для не-API сценариев) |

## ChatPlace

| `CHATPLACE_API_BASE` = `https://api.chatplace.io/v1` |
| `CHATPLACE_API_KEY` |
| `CHATPLACE_WEBHOOK_TOKEN` |
| `CHATPLACE_IG_BOT_ID` |
| `CHATPLACE_MCP_URL` |

## GetCourse

| `GC_ACCOUNT` `GC_API_KEY` `GC_WEBHOOK_SECRET` `GC_BASE_OFFER_ID` `GC_BASE_PRICE_KOPECKS` `GC_API_BASE` `GC_PULL_PAGE_SIZE` `GC_PULL_DISABLED` |

## Cloudinary / Google Drive

| `CLOUDINARY_CLOUD_NAME` `CLOUDINARY_API_KEY` `CLOUDINARY_API_SECRET` `CLOUDINARY_UPLOAD_FOLDER` |
| `CLOUDINARY_FALLBACK_LOCAL_DIR` = `/var/www/cdn` |
| `GDRIVE_SERVICE_ACCOUNT_JSON_PATH` — путь к json |
| `GDRIVE_LONGREADS_FOLDER_ID` `GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID` `GDRIVE_YE_PHOTO_FILE_ID` |

## Image generation

| `IMAGE_PROVIDER` = `gptunnel` (или `gemini` / `placeholder` / `template`) |
| `GPTUNNEL_API_KEY` |
| `BILLING_DAILY_ALERT_KOPECKS` = `50000` (500 ₽) |
| `CAROUSEL_USE_TEMPLATES` = `true` (использовать SVG-шаблоны MOSSEBO из GDrive) |
| `CAROUSEL_MODE` = `edit` / `html` / `style_transfer` |
| `CAROUSEL_HTML_TEMPLATE` = `yury-universal-v1` |
| `CAROUSEL_EDIT_CONCURRENCY` = `4` |
| `CAROUSEL_TEMPLATES_LOCAL_DIR` = `/var/www/cdn/templates` |
| `CAROUSEL_TEMPLATES_TTL_S` = `300` |

## Embeddings (KB / voice samples)

| `EMBEDDING_PROVIDER` = `openai` |
| `OPENAI_API_KEY` (если используется напрямую) |
| `EMBEDDING_MODEL` = `text-embedding-3-large` |
| `EMBEDDING_DIM` = `1536` |

## Voice validator

| `VOICE_VALIDATOR_MIN_DENSITY` = `0.3` |
| `VOICE_VALIDATOR_MAX_RETRIES` = `3` |
| `STRATEGY_A_MIN_SIMILARITY` = `0.85` |
| `STRATEGY_C_MAX_SIMILARITY` = `0.65` |
| `STRATEGY_B_PERIOD_IDEAS` = `10` |
| `STRATEGY_COLD_START_FALLBACK_B` = `false` |
| `LONGREAD_MIN_WORDS` = `1500` / `LONGREAD_MAX_WORDS` = `2500` |
| `WARMUP_LONG_TAIL_WEEKS` = `8` |

## Дев / диагностика

| `TEST_ENDPOINT_TOKEN` — bearer для `/test/image-gen` |
| `NANO_BANANA_PLACEHOLDER_MODE` — generation шаблонов вместо AI (smoke) |
| `GEMINI_HTTPS_PROXY` — прокси для Gemini API (РФ-VPS) |
| `PROMETHEUS_PORT` = `9090` |
