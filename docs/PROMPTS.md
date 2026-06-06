# Промпты club-funnel-agent

## Структура

Все активные промпты в `src/prompts/`:

| Файл | Версия | Назначение |
|---|---|---|
| `twin-ye.ts` | v3 | Голос Юрия (рилс / tg_post / carousel / generic) |
| `twin-rz.ts` | v3 | Голос Виктории (участница клуба) |
| `carousel-text.ts` | v3 | Тексты слайдов карусели |
| `twin-ye.v1.ts` | v1 (legacy) | Используется idea-builder и content-edit |
| `twin-ye.v2.ts` | v2 (legacy) | Используется ig-caption-generator + smoke-скрипты |
| `twin-rz.v2.ts` | v2 (legacy) | smoke-скрипты |
| `longread-writer.v1.ts` | v1 | Лонгриды (longread-factory) |

## twin-ye.ts (v3) — голос Юрия

Динамический `buildTwinYePrompt({ pool, ideaText, codeWord, kind, sampleCount })`.

### Содержимое промпта

1. **База**: voice-analysis из `knowledge/voice-analysis-ye-v3.md` (JSON от Opus 4.8 на 18 IG-постах)
2. **18 characteristic_phrases** — обороты Юрия («Я часто слышу», «Парадокс в том», …)
3. **29 forbidden_constructions** — что НИКОГДА не используется
4. **8 real_stories** — Анна Кацапова (3500→8000, Нижневартовск), Наталья Собур, Ануш, Анна Чернышова, …
5. **Top-5 эталонных постов** из `yury_voice_samples` (cosine top-K)
6. **kindRequirementsBlock(kind)** — жёсткие требования по типу:
   - `reel`: 200-400 слов, 6 блоков (Хук → История → Личная позиция Юрия → Разбор → Обращение на «ты» → Концовка), ≥1 имя из real_stories, ≥2 цифры, ≥1 город, ≥3 характерных оборота, ≥1 «ты», ≥5 коротких предложений
   - `tg_post`: 300-600 слов, аналогично + ≥3 цифры, ≥6 коротких
   - `carousel`: текст для слайдов + правила без эмодзи
   - `generic`: базовые правила

### Параметры вызова

- **Модель:** `claude-sonnet-4-6`
- **Temperature:** `0.85`
- **maxTokens:** `4000`
- **Тип валидации:** `validateVoiceV3` с `HistoryContext` (7 дней + 3 последних рилса)

## twin-rz.ts (v3) — Виктория, участница клуба

Та же логика что twin-ye, но:
- Виктория — НЕ куратор, НЕ наставник. Она такая же дизайнер-резидент.
- Юрий для неё — ментор, к которому она прислушивается.
- Её посты — её ЛИЧНАЯ история изменений изнутри клуба.
- 6 блоков для reel/tg_post: Хук (личная боль) → Контекст её цифр → Поворотный момент в клубе → Её действие+результат → Обращение на «ты» → Финал
- Кейсы других резиденток — ТОЛЬКО как зеркало для её истории, не как наблюдение.

Запрещено: «Я разбирала с [имя]», «Мы с участницами», «оказалась» в смысле «поняла».

## carousel-text.ts (v3) — тексты слайдов

- Берёт согласованный YE-пост + voice-analysis + real_stories whitelist
- Генерит 10 фраз (по умолчанию) для слайдов
- Никаких выдуманных имён/цифр

## voice-validator-v3.ts

Динамический валидатор. Принимает `kind`, `history`, текст.

### Типы нарушений

| kind | Описание |
|---|---|
| `forbidden` | Запрещённое слово/конструкция (из voice-analysis.forbidden_constructions) |
| `profession` | Профессиональная ошибка (например, «дорогой чек» вместо «высокий чек») |
| `price` | Прямое упоминание цены клуба (sacred rule #11) |
| `curator` | Куратор-голос вместо личного («мы с участницами…», «я разбирала с…») |
| `length` | Длина вне диапазона (reel 200-400, tg_post 300-600) |
| `missing_element` | Отсутствует обязательный элемент (имя из real_stories, цифра, город, «ты», обороты, короткие предложения) |
| `hallucinated_capital` | Capitalized слово в середине предложения, не из whitelist (real_stories.name + city + COMMON_RU_TITLES) |
| `jarring_metaphor` | Существительные из JARRING_NOUNS (матрас, тротуар, паркинг, диван, …) встретились 1 раз без развёртывания |
| `repeated_ending` | Шаблонная концовка повторяется (последние 7 дней) |
| `weather_hook_overuse` | Погодный хук (минус N за окном, дождь, снег) в reel при том что уже использован в последних 3 рилсах |

### HistoryContext

- `last7DaysText` — все tg_post + reel_caption за 7 дней (для repeated_ending)
- `last3ReelsText` — последние 3 reel_caption (для weather_hook_overuse)

Грузится через `loadHistoryContext(pool)` в `content-gen.ts` перед вызовом промптов.

## Почему 4 параллельных вызова, а не один

В `content-gen.ts` отдельно вызываются:
1. `buildTwinYePrompt({ kind: 'reel' })`
2. `buildTwinYePrompt({ kind: 'tg_post' })`
3. `buildTwinYePrompt({ kind: 'carousel' })` (через `buildCarouselTextPrompt`)
4. `buildTwinRzPrompt({ kind: 'tg_post' })`

Причина — Sonnet 4.6 лучше следует жёстким требованиям длины/блоков когда задача узкая.
