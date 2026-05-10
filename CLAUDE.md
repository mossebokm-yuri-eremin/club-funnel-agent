# CLAUDE.md — инструкция Claude Code для club-funnel-agent

## Что это

Контент-агент Юрия Еремина (YE), приводящий дизайнеров интерьеров в клуб «Реализация» (5000 ₽/мес). Полная спецификация — в `SPEC.md`. Здесь — кратко то, что нужно держать в голове на каждой задаче.

## Главные правила (нарушение = блок задачи)

1. **Единственный CTA — клуб «Реализация».** Никаких продаж наставничества, мини-курсов, других продуктов.
2. **Голос Юрия — sacred.** Каждый текст YE/RZ проходит VOICE VALIDATOR (см. `src/services/voice-validator.ts`). Запрещены: «УТП», «возражения», «синергия», «хочу поделиться», «целевая аудитория». Обязательны маркеры YE: «угу», «вот», «то есть», «погнали».
3. **Никаких УТП — только смыслы.** Контент строится по StoryBrand SB7. См. `src/prompts/longread-writer.ts`.
4. **Деньги — INTEGER в копейках.** Никогда float/numeric для денег. 5000 ₽ = `500000` копеек. Поля `*_kopecks`, тип `BIGINT`.
5. **152-ФЗ.** Все ПД — только на Beget VPS. `subscribers`, `bonus_library`, `references_inbox` — только soft-delete (`deleted_at`). Hard delete у app-роли отозван.
6. **Платежи — только GetCourse.** Мы не управляем оплатой. Webhook валидируется по HMAC SHA-256 (`src/webhooks/getcourse.ts`). Hourly pull для reconcile.
7. **Воронки — только ChatPlace API.** Мы не имитируем чат-боты в IG.
8. **Все секреты — в `.env`** (права 600), копия в Bitwarden. В git — никогда. `.env.example` синхронизируется при добавлении переменной.

## Структура репо

```
src/
  bot/             # grammY handlers
  core/            # бизнес-логика без I/O (state machines, valid rules)
  services/        # сервисы (stt, idea-builder, strategy-chooser, content-gen,
                   #          longread-factory, voice-validator, ...)
  integrations/    # внешние API (anthropic, gemini, deepgram, chatplace,
                   #               getcourse, instagram, ytdlp, cloudinary, gdrive)
  webhooks/        # fastify routes для webhooks
  jobs/            # BullMQ workers
  prompts/         # system prompts (TypeScript const exports, версионируем v1/v2)
  db/              # pg client, миграции, repositories
  observability/   # pino logger, prometheus metrics
templates/         # longread.hbs, slide-template.hbs
migrations/        # SQL миграции, нумерованные
tests/             # Vitest
docs/              # 152fz-policy.md, runbooks, ADRs
```

## Workflow для типовых задач

- **Поправить голос YE/RZ:** `src/prompts/twin-{ye,rz}.v*.ts` + миграция в `voices` (новый `system_prompt`). Bump версии prompt'а.
- **Добавить новую интеграцию:** `src/integrations/<name>.ts` + Zod schemas + tests (мокают HTTP через `msw`).
- **Изменить схему БД:** новая миграция `migrations/00X_<name>.sql` (никогда не редактируем существующие).
- **Перед PR:** `pnpm lint && pnpm test && pnpm typecheck`. CI блокирует при failures.
- **Запуск локально:** `pnpm dev` (читает `.env.local`, в нём sandbox креды).

## Что трогать осторожно

- `migrations/` — только новые файлы, никогда не правим старые после применения в проде.
- `src/prompts/` — изменения требуют записи в `prompt_versions` + проверки на eval-сете.
- `voices` (БД) — изменения через миграцию, не SQL вручную.
- HMAC verify в `src/webhooks/getcourse.ts` — критическая секьюрити-зона, любое изменение требует ревью.

## Что НЕ делать (anti-patterns)

- ❌ Не ставить `numeric`/`float` под деньги.
- ❌ Не делать `DELETE FROM subscribers` (вообще нигде в коде).
- ❌ Не вызывать LLM из обработчиков webhook напрямую — всегда через очередь.
- ❌ Не парсить `req.body` для GC webhook без сохранения raw bytes (HMAC сломается).
- ❌ Не использовать `console.log` — только `log.{debug,info,warn,error}`.
- ❌ Не складывать креды/токены в логи (используется redact в pino).
- ❌ Не предлагать продажу наставничества/курсов (см. NON-GOALS в SPEC §13).

## Тесты, которые обязательно зелёные

- `voice-validator.test.ts` — отбраковывает все запрещённые слова, не пропускает «УТП», ловит низкую плотность маркеров.
- `webhook-getcourse.test.ts` — отбивает невалидный HMAC, принимает валидный, идемпотентен.
- `strategy-chooser.test.ts` — таблица: similarity > 0.85 → A, < 0.65 → C, среднее → решение Opus.
- `reference-detector.test.ts` — опознаёт пересланный Reels по 4 признакам (URL/forward_origin/media+forward без caption/IG-bridge).

## Полезные команды

```bash
pnpm dev                                   # локальный запуск
pnpm migrate:up                            # применить миграции
pnpm seed:voices                           # перечитать voices из миграции 002
pnpm refresh:brain                         # ручной запуск AUDIENCE BRAIN
pnpm pdf:render -- --bonus-id <uuid>       # перерендерить лонгрид
pnpm reports:weekly -- --week <YYYY-WW>    # сгенерировать недельный отчёт
```

## При сомнениях

1. Открой `SPEC.md`, найди соответствующую секцию (Acceptance Criteria, Edge Cases, Integrations).
2. Если в SPEC ответа нет — спроси у YE до того, как кодить.
3. Не срезать углы. Лучше медленнее и качественно.
