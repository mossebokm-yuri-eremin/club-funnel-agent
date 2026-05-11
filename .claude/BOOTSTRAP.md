# BOOTSTRAP — первый запуск Claude Code в проекте club-funnel-agent

## Что вводить первым промтом

Скопируй текст ниже **целиком** и отправь Claude Code в Bypass-режиме как первое сообщение:

---

```
Прочитай CLAUDE.md и SPEC.md полностью. Это твоя библия для проекта.

После прочтения создай TodoWrite-план реализации MVP по SPEC, разбитый на фазы:

Фаза 0 — bootstrap проекта:
- package.json (TypeScript strict, pnpm, grammY, fastify, BullMQ, pg, ioredis,
  @anthropic-ai/sdk, pino, vitest, zod, dotenv, handlebars)
- tsconfig.json (strict, ES2023, NodeNext)
- vitest.config.ts
- .gitignore (node_modules, dist, .env, *.log)
- src/index.ts (entry), src/config.ts (Zod-validated .env)
- src/observability/logger.ts (pino + redact secrets)
- src/db/client.ts (pg pool)
- src/redis.ts (ioredis)
- структура каталогов: src/{bot,core,services,integrations,webhooks,jobs,prompts,db,observability}/

Фаза 1 — фундамент (SPEC §3, §4):
- src/db/migrate.ts — раннер миграций
- pnpm migrate:up должен поднять 001_initial.sql и 002_seed_voices.sql
- src/services/voice-validator.ts + tests/voice-validator.test.ts (см. CLAUDE.md, обязательный)
- src/webhooks/getcourse.ts с HMAC verify + tests (обязательный)
- pnpm typecheck && pnpm test — зелёные

Фаза 2 — захват входов (SPEC §2.1, §2.13):
- src/bot/* — grammY handlers для голос/референс
- src/services/reference-detector.ts + tests (обязательный)
- src/services/stt.ts (Deepgram через integration)

Фаза 3 — генерация контента (SPEC §2.3–2.6):
- src/services/idea-builder.ts
- src/services/strategy-chooser.ts + tests (обязательный)
- src/services/content-gen.ts
- src/services/longread-factory.ts
- src/prompts/*.ts (twin-ye, twin-rz, longread-writer)

Фаза 4 — воронка и аналитика (SPEC §2.10, §2.11):
- src/integrations/chatplace.ts
- src/integrations/getcourse.ts (HMAC + hourly pull)
- src/services/funnel.ts
- src/jobs/* (BullMQ workers)
- src/services/analytics.ts

Каждая фаза:
1. План в TodoWrite.
2. Кодирование с тестами параллельно.
3. После завершения фазы — pnpm lint && pnpm typecheck && pnpm test.
4. Вызов subagent `reviewer` (см. .claude/agents/reviewer.md) — 3 круга проверки.
5. Только после ✅ APPROVED — git commit.

Сейчас начни с Фазы 0 — план + код. Жду TodoWrite с разбивкой и первый коммит после Фазы 0.

ВАЖНО:
- Если в SPEC противоречие или непонятно — НЕ ПРИДУМЫВАЙ. Останови работу,
  сформулируй вопрос и спроси Юрия. Лучше пауза, чем код наугад.
- Юрий устал и хочет автономной работы. Минимизируй уточняющие вопросы,
  задавай только когда без ответа ехать нельзя.
- Используй TodoWrite на каждом нетривиальном шаге, чтобы Юрий видел прогресс.
- Все секреты из .env — НИКОГДА в код. Если переменная отсутствует — пиши
  понятную ошибку через config.ts.

Погнали.
```

---

## Если Claude Code остановится с вопросом

Это нормально — SPEC большой, могут быть неоднозначности. Отвечай конкретно.
Если не знаешь — открой SPEC.md и найди по ключевому слову.

## Когда дойдёт до деплоя

Перед `git push` Claude Code должен:
1. Прогнать `pnpm test` локально (Postgres+Redis локально или через Docker — пусть решает сам).
2. Вызвать `reviewer` ещё раз.
3. Создать PR/коммит.

На VPS деплоится через `scripts/deploy.sh` (Architect его уже сгенерил).

---

## Если что-то пойдёт не так

- Stop генерацию (Esc), скажи в чём проблема, попроси откатить.
- Не давай Claude Code трогать `.env` с реальными секретами — он работает на основе шаблонов.
- Git история — твоя страховка. После каждой фазы — коммит.
