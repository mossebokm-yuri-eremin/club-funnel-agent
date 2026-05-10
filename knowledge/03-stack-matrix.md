# Stack Matrix — Задача → Оптимальный стек

## Как использовать

Определи тип агента/продукта → найди строку → используй стек.
Если не знаешь тип — сначала пройди Problem Discovery (prompts/01-problem-discovery.md).

---

## Матрица по типу продукта

### Telegram-бот (любой)
```
Runtime:    Node.js LTS
Bot API:    Telegram Bot API (@BotFather)
База:       Supabase (PostgreSQL + RLS)
AI:         Claude API (Opus для сложного, Haiku для категоризации)
MCP:        Context7 + Supabase MCP
Деплой:     VPS Beget (если данные РФ) / Vercel (если без ПД)
Секреты:    TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY
```
Рецепт: `recipes/telegram-bot.md`

---

### Веб-приложение / SaaS
```
Frontend:   Next.js 16 (App Router), TypeScript, Tailwind v4, shadcn/ui
Backend:    Supabase (Auth + PostgreSQL + RLS)
Платежи:    ЮKassa (РФ) / Stripe (не РФ)
Деплой:     VPS Beget (с ПД) / Vercel (без ПД)
CI/CD:      GitHub Actions
SSL:        Certbot (Let's Encrypt)
MCP:        Context7 + Supabase MCP + GitHub MCP
```

---

### Финансовый агент / Аналитика
```
Runtime:    Node.js LTS
Bot UI:     Telegram Bot
База:       Supabase
AI:         Claude API (Opus для аналитики, Haiku для категоризации)
Правило:    Деньги = integer × 100 (никогда float!)
MCP:        Context7 + Supabase MCP
Деплой:     VPS Beget
```
Рецепт: `recipes/financial-director.md`

---

### CRM-агент
```
База:       Supabase (таблицы clients, orders, statuses)
Bot UI:     Telegram Bot
AI:         Claude API
Интеграция: WhatsApp (через сторонние API) / Telegram
MCP:        Context7 + Supabase MCP
Деплой:     VPS Beget (ПД клиентов!)
Правило:    RLS обязательна, owner_id на каждой записи
```
Рецепт: `recipes/crm-agent.md`

---

### Контент-агент
```
Среда:      claude.ai → Project (НЕ VS Code)
Инструкции: System prompt в Project Instructions
Документы:  Загружены в Project (бренд, стиль, аудитория)
Модель:     Claude Opus 4.7 + Extended Thinking
Выход:      Текст в чате → копируй
Автоматизация: Telegram-бот (Шаг 10 в content-agent/0-ROADMAP.md)
```
Рецепт: `recipes/content-agent.md`

---

### Telegram Mini App (дашборд/аналитика)
```
Frontend:   React + Vite + Tailwind v4 (НЕ Next.js — легковеснее для Mini App)
База:       Supabase (PostgreSQL + RLS)
Backend:    Node.js API на VPS (бизнес-логика и AI-вызовы ТОЛЬКО на бэке)
AI:         Claude API через бэкенд (никогда через фронт!)
Бот-хост:   Уже существующий Telegram-бот
Деплой:     Vercel (фронт) + VPS Beget (бэкенд)
Принцип:    Сначала агент, потом платформа управления им
Правило:    Фронт получает готовые тексты от бэка — не вызывает Anthropic напрямую
```
Конспект: `summaries/lesson-13-dashboard-analytics.md`

---

### Продвинутый AI-агент (с памятью и RAG)
```
Runtime:    Node.js LTS
AI:         Claude API (claude-sonnet-4-6 для диалога, Opus для сложных задач)
Память:     Supabase pgvector (векторная база для RAG)
Кэш:        Prompt Caching (экономит до 90% токенов на повторных запросах)
Голос:      Deepgram (транскрибация голосовых сообщений)
База:       Supabase (история диалогов + векторные эмбеддинги)
Бот UI:     Telegram Bot
Деплой:     VPS Beget (PM2)
```

---

### SERM-система (управление репутацией)
```
Runtime:    Node.js LTS
Парсинг:    Puppeteer / Playwright (мониторинг упоминаний)
База:       Supabase
AI:         Claude API (анализ тональности)
Уведомления: Telegram Bot
Планировщик: cron (или pm2)
MCP:        Context7 + Supabase MCP
Деплой:     VPS Beget
Право:      Проверить 149-ФЗ об информации
```

---

### SaaS-платформа (многопользовательская)
```
Frontend:   Next.js 16 + TypeScript + Tailwind v4 + shadcn/ui
Auth:       Supabase Auth (email + OAuth)
База:       Supabase + RLS (изоляция по user_id)
Платежи:    ЮKassa (подписки)
Деплой:     VPS Beget (если ПД) / Vercel + Supabase Cloud
Email:      Resend / SendGrid (транзакционные письма)
MCP:        Context7 + Supabase + GitHub
```

---

### Автоматизация бизнес-процессов
```
Оркестрация: Claude Code (с субагентами)
База:        Supabase
Триггеры:    Telegram / Webhook
Планировщик: cron / pm2
MCP:         Context7 + Supabase + GitHub + (N8n если нужна визуальная автоматизация)
Деплой:      VPS Beget
```

---

### Образовательная платформа / Курс
```
Frontend:   Next.js 16 + shadcn/ui
Auth:       Supabase Auth
База:       Supabase (courses, lessons, progress, users)
Видео:      Kinescope / Vimeo (стриминг)
Платежи:    ЮKassa
Деплой:     VPS Beget
MCP:        Context7 + Supabase + GitHub
```

---

## Решение по моделям Claude API

| Задача | Модель | Почему |
|--------|--------|--------|
| Написание архитектуры/спеки | Opus 4.7 + Extended Thinking | Сложные решения |
| Генерация кода | Sonnet 4.6 | Баланс качества и скорости |
| Категоризация данных | Haiku 4.5 | Быстро и дёшево |
| Анализ документов | Opus 4.7 | Точность важна |
| Рутинные задачи | Haiku 4.5 | Экономия |
| Ревью кода | Sonnet 4.6 | Достаточно точен |

---

## Когда использовать claude.ai Projects (не VS Code)

| Сценарий | Инструмент |
|----------|------------|
| Простой чат-агент без кода | claude.ai Project |
| Контент-агент (тексты, посты) | claude.ai Project |
| Анализ документов вручную | claude.ai Project |
| Разработка кода + файлы + git | VS Code + Claude Code |
| Автономная сборка агента | VS Code + Claude Code |
| Создание спецификации | claude.ai (Opus + Extended Thinking) |

---

## Стоимость инфраструктуры (ориентир)

| Компонент | Стоимость | Тариф |
|-----------|-----------|-------|
| Supabase | Бесплатно | Free (500MB БД) |
| VPS Beget | ~330 ₽/мес | 1 ядро / 1GB |
| Domain | ~200 ₽/год | .ru |
| Claude API | от $5/мес | По использованию |
| Telegram Bot | Бесплатно | — |
| GitHub | Бесплатно | Free |
| Context7 | Бесплатно | — |
| **Итого MVP** | **~500-2000 ₽/мес** | — |
