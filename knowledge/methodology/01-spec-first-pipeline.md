# Spec-First Pipeline — Методология

## Философия

> "Большинство продуктов проваливаются не из-за плохого кода, а из-за того, что решают несуществующую проблему."

**Принцип:** сначала — полная документация. Потом — код.
30 минут спецификации = часы сэкономленной работы Claude Code.

---

## Шаг 0: Problem Discovery (обязательный первый шаг)

**Промт:** `prompts/01-problem-discovery.md`
**Где запускать:** claude.ai (Opus 4.7 + Extended Thinking)
**Результат:** Problem Statement документ

**Фреймворк:**
```
Боль → Корневая причина → Последствия → Решение → Ценность
```

**6 этапов:**
1. Идентификация боли (5-10 болей → ТОП-3)
2. Root Cause Analysis (5 Whys для каждой боли)
3. Cost of Inaction (потери в рублях за месяц/год)
4. Solution Framing (трансформация: ИЗ → В → ЧЕРЕЗ → ЗА)
5. Value Proposition (Elevator Pitch 30 секунд)
6. Validation Checklist (7+ Да = проблема сформулирована правильно)

---

## Шаг 1: PROJECT_IDEA.md

**Шаблон:** `templates/project-idea.md`
**Где генерировать:** claude.ai → Project с Agent Architect Prompt в Instructions
**Что включает:**
- Проблема и кто страдает
- Боль (точная формулировка)
- Цена проблемы
- Целевая аудитория
- Формула ценности
- 7 ключевых функций MVP
- Что НЕ входит в MVP (важно!)
- Стек и бюджет
- Дедлайны
- Монетизация

**Ключевые правила:**
- Включи блок "НЕ наша аудитория" — он отсекает неправильных клиентов
- Формула ценности — одна строка: "Мы решаем [X] через [Y], что даёт [Z]"
- Бюджет: Supabase Free + VPS Beget (~11 ₽/день) + Claude API = до 5000 ₽/мес

---

## Шаг 2: SPEC.md (техническая спецификация)

**Промт:** `prompts/03-spec-write.md`
**Где запускать:** claude.ai (Opus 4.7 + Extended Thinking) с PROJECT_IDEA.md
**Результат:** 500-1500 строк детальной спецификации
**Время Claude:** 2-5 минут

**7 блоков SPEC.md:**
```
Блок 0: Обзор проекта (стек, роли, маршруты)
Блок 1: User Stories (минимум 8, с критериями приёмки)
Блок 2: Data Model (SQL-схема с RLS-политиками)
Блок 3: Tool Use (API инструменты: Claude API, Telegram Bot, etc.)
Блок 4: UI/UX (экраны, состояния, команды)
Блок 5: Business Logic (алгоритмы, правила)
Блок 6: Edge Cases (минимум 10 сценариев!)
    + Структура проекта (дерево файлов)
```

**Типичные ошибки в спеке:**
| Ошибка | Исправление |
|--------|-------------|
| Абстрактные описания | Запроси пошаговый алгоритм с кодом |
| Нет RLS | Добавить CREATE POLICY для каждой таблицы |
| Nет примеров JSON | Запроси полный JSON-ответ |
| Edge Cases < 10 | Добавь: сеть, безопасность, лимиты, платежи |
| Stripe вместо ЮKassa | Stripe не работает в России → ЮKassa |
| Supabase Edge Functions | Заменить на API Route в Next.js или Node.js на VPS |
| TODO в тексте | Прими решение, зафикси |

---

## Шаг 3: CLAUDE.md + Субагенты

**Инструмент:** `CLAUDE_CODE_SETUP_GENERATOR.md` из Toolkits курса
**Где запускать:** claude.ai → загрузи SPEC.md + Setup Generator + Subagent Architect Guide
**Промт:** "Привет! В этом проекте мы будем разрабатывать [название]. Прочитай файлы. Создай CLAUDE.md и команду субагентов."
**ВАЖНО:** Включи Plan Mode перед отправкой.

**Результат (полный пакет):**
```
CLAUDE.md
.claude/agents/database-architect.md
.claude/agents/backend-engineer.md
.claude/agents/frontend-developer.md
.claude/agents/qa-reviewer.md
.claude/rules/domain-rules.md
.claude/rules/security-rules.md
.claude/skills/[skill]/SKILL.md
MCP-команды для Context7, Supabase, GitHub
Финальный Kickoff промт
```

---

## Шаг 4: MCP подключение

**Порядок подключения:**
1. Context7 — глобально (один раз на все проекты):
   Написать в Claude Code: "подключи Context7 глобально"
   
2. Supabase MCP — локально в проекте:
   Зайти на supabase.com → Project Settings → MCP → Connect → скопировать команду → выполнить в Claude Code

3. GitHub MCP — локально:
   Создать Personal Access Token на GitHub → положить в .env как GITHUB_TOKEN → написать Claude Code: "подключи GitHub MCP"

---

## Шаг 5: Автономная сборка (Kickoff)

1. Открыть папку проекта в VS Code (File → Open Folder)
2. Запустить Claude Code
3. Проверить: Context7 ✅, Supabase ✅, GitHub ✅
4. Включить Bypass Permissions
5. Вставить Kickoff промт (из пакета шага 3)
6. Ждать сборки (не мешать)

**Если Claude застрял:** спроси в чате — он скажет что нужно.

---

## Шаг 6: Code Review

**Промт:** `prompts/04-code-review.md`
**Когда:** после завершения автономной сборки
**Что проверяет:** архитектура, безопасность, производительность, соответствие спеке

---

## Шаг 7: Деплой на VPS

**Полный гайд:** `knowledge/08-vps-deploy.md`
**Хостинг:** Beget (российский, 152-ФЗ)
**CI/CD:** GitHub Actions → автодеплой при push в main

---

## Правила методологии

1. **Никогда не пиши код без спеки** — сначала PROJECT_IDEA → SPEC → CLAUDE.md
2. **Один проект = одна папка = одно окно VS Code** — не смешивай проекты
3. **Agent Architect Prompt — в Project Instructions, не в чат** — это системный промт
4. **Сначала Plan Mode, потом Bypass** — при создании CLAUDE.md всегда Plan Mode
5. **Сделай один модуль до идеала, потом следующий** — не распыляйся
6. **Не экономь на Opus** — архитектурные решения только на Opus 4.7
7. **Context7 = всегда** — подключён глобально, работает автоматически
