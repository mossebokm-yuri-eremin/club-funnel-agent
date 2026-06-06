# club-funnel-agent — docs/

Актуальная документация по состоянию на 2026-06-06.

## Что это за проект

`club-funnel-agent` — Telegram-бот, который превращает голосовое сообщение Юрия Еремина
в готовый пакет контента (рилс + TG-пост + карусель + RZ-вариант от Виктории) и
автоматически разворачивает воронку в Instagram через ChatPlace.

Цель — пополнение клуба «Реализация» (5000 ₽/мес) через органический IG-трафик,
без ручной сборки воронок.

## Ключевые файлы документации

| Файл | Что описывает |
|---|---|
| [README.md](README.md) | Этот файл |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Полный pipeline: TG → STT → idea → content → carousel → approval → ChatPlace |
| [PROMPTS.md](PROMPTS.md) | Twin-YE, Twin-RZ, carousel-text, voice-validator-v3: что, как, почему |
| [DEPLOY.md](DEPLOY.md) | Где живёт прод, как ставить апдейты, как откатывать |
| [ENV.md](ENV.md) | Все env-переменные с пояснениями |
| [E2E_FINAL_2026-06-06.md](E2E_FINAL_2026-06-06.md) | Последний боевой прогон (метрики, code_word, ChatPlace id) |
| [archive/](archive/) | Исторические документы (старые аудиты, OAuth setup, TZ-для-Сергея) |

## Главные документы в корне проекта

- [../SPEC.md](../SPEC.md) — техническая спецификация (AC-1 .. AC-30)
- [../CLAUDE.md](../CLAUDE.md) — инструкции для агента
- [../README.md](../README.md) — описание для GitHub
- [../backlog.md](../backlog.md) — что в работе / что в очереди
