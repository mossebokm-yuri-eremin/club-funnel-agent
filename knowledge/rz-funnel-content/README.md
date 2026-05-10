# База знаний — Контент-агент воронки в Реализацию (RZ)

> **Назначение:** полный пакет знаний для будущего агента, который будет создавать контент воронки в сообщество дизайнеров «Реализация».
> **Используется** Архитектором при проектировании этого агента — и далее самим агентом как референс.
> **Версия:** 2.0 (расширенная — глубокий проход) | **Дата:** 2026-05-10

---

## Что внутри (7 файлов)

| Файл | О чём | Объём |
|---|---|---|
| [01-audience-portrait.md](01-audience-portrait.md) | Психологический портрет ЦА: 18 болей, 20 страхов, 20 заблуждений, 10 загонов, 12 сомнений, 18 мифов, 18 желаний, 13 мечтаний | ~6 500 слов |
| [02-yuri-quotes.md](02-yuri-quotes.md) | 150+ дословных цитат Юрия по 9 темам + 40 уникальных метафор и хуков | ~6 500 слов |
| [03-cases-methodology.md](03-cases-methodology.md) | 20 кейсов резидентов + методология коммуникации (StoryBrand, стоп-слова, 10 триггеров, SEO/GEO, 20-пунктовый анти-список) | ~6 000 слов |
| [04-live-language-cases.md](04-live-language-cases.md) | **NEW.** Живой язык участников (124 фразы), 33 диалога Юрия, 33 победы, 7 архетипов, разборы аккаунтов, master-plan-5000, скрипт Татьяны, design brief Дениса, разбор Вадима | ~7 500 слов |
| [05-vsl-sales-frameworks.md](05-vsl-sales-frameworks.md) | **NEW.** VSL-структура (14 блоков), курс Жигилия (5-шаговая работа с сомнениями), курс Натальи Тереховой, кастдев-система, нейромаркетинг, 12-week-year, Токовинин, контент-стратегия наставника | ~7 500 слов |
| [06-voice-mastering.md](06-voice-mastering.md) | **NEW.** Полный список разговорных маркеров Юрия (22 категории), 65 новых дословных цитат, путь клиента по AIDA, 17 шагов встречи, 8 блоков самопрезентации, KPI YE+RZ, игровая механика «Студия» | ~7 500 слов |
| [07-real-posts-bot-funnel.md](07-real-posts-bot-funnel.md) | **NEW.** 26 готовых постов Юрия (дословно), полная воронка SaleBot клуба + наставничества, Instagram контент-стратегии, SaleBot deep analysis (3 силоса, проблемы), план трансформации контента (5 стадий, ТОП-10 причин, банк хуков, 10 утверждённых рилсов) | ~8 000 слов |

**Итого:** ~50 000 слов структурированной базы знаний для одного агента.

---

## Как использовать

### Сценарий 1 — Архитектор проектирует агента

При команде `ARCHITECT: контент-агент воронки РЗ` Архитектор:
1. Читает все 7 файлов из этой папки
2. Использует портрет ЦА (01) для определения tone of voice
3. Использует цитаты (02) и мастеринг голоса (06) для формирования голоса агента
4. Использует кейсы (03, 04) для системы социальных доказательств
5. Использует методологии (03, 05) как guardrails и фреймворки
6. Использует готовые посты (07) как эталон output
7. Использует воронку SaleBot (07) для понимания где агент работает
8. Выдаёт Roadmap с учётом всех ограничений

### Сценарий 2 — Сам агент пишет контент

Будущий контент-агент при генерации поста/рилса:
1. Берёт триггер из ландшафта ЦА (боль/страх/мечта) → файл **01**
2. Подбирает релевантную цитату Юрия для хука → **02, 06**
3. Подкрепляет кейсом с именем + цифрой + городом → **03, 04**
4. Применяет VSL/Жигилий/Наталья методологию → **05**
5. Применяет правила голоса (длина, маркеры, метафоры, стоп-слова) → **06**
6. Использует структуру похожего готового поста как шаблон → **07**
7. Соотносит с этапом воронки SaleBot → **07**
8. Проверяет по чеклисту перед публикацией → **05**

---

## Источники (что было прочитано — 70+ wiki-файлов)

### wiki/1-yuri-eremin/
audience.md, voice-portrait.md, cases.md, achievements.md, content-strategy.md, mk-sarkazi-itogoviy-scenariy.md, mk-sarkazi-tz-dizaineru.md, deep-audience-content-system.md, samoprezentatsiya.md, put-klienta.md, rules.md, kpi.md, course-v2.md, content-plan-transformation.md, bot-klub-full-messages-v2.md, bot-klub-full-messages.md, bot-klub-realizatsiya.md, bot-nastavnichestvo-full-messages-v2.md, bot-nastavnichestvo-full-messages.md, bot-nastavnichestvo.md, instagram-content-klub.md, instagram-content-nastavnichestvo.md, salebot-deep-analysis.md, salebot-funnel.md, posts-ready/ (9 файлов, 140+ постов)

### wiki/2-realizatsiya/
overview.md, attraction-content.md, content-matrix.md, content.md, engagement-system.md, engagement-game.md, master-plan-5000.md, build-sequence.md, chat-analysis.md, members.md, events.md, kpi.md, tatyana-razbor-guide.md, design-brief-denis.md

### wiki/concepts/
smysly-i-tsennosti.md, storybrand.md, pozitsionirovanie.md, stop-slova-VG-UA.md, sales-system-rules.md, ye-uniqueness.md, mini-kurs-neyromarketing.md, trendy-socialmedia-2026.md, seo-geo-guide.md, dzen-ai-detection.md, samoprezentatsiya-dizaynera.md, castdev-system.md, tsa-marketing-strategy.md, 12-week-year.md, content-strategy-nastavnik.md, natalya-nastavnichestvo-sales-course.md, vsl-struktura.md, zhigiliy-master-argumenta.md, zhigiliy-master-zvonka.md

### wiki/summaries/
file-01-tselevaya-auditoriya.md, file-02-opyt-i-keysy.md, file-03-programma-metodologiya.md, file-04-progress-reports.md, file-05-globalnyy-kontekst.md, matritsa-kontenta-tsa.md, klub-chat-analysis-extended.md, chat-analysis-27apr-02may-2026.md, razbory-soobshchestvo-05-05-2026.md, nastavnichestvo-gruppa1-vstrechi.md, nastavnichestvo-gruppa2-vstrechi.md, nastavnichestvo-gruppa3-vstrechi-1-17.md, nastavnichestvo-gruppa3-vstrechi-18-34.md, ye-podkast-1-pozitsionirovanie.md, ye-podkast-2-avtorskiy-nadzor.md, ye-podkast-3-tsena-postoyannomu.md, ye-podkast-4-dogovor-sudy.md, ye-podkast-5-soglasovanie.md, ye-finalnie-smysly.md, ye-vsl-struktura-2026-04-23.md, ye-telegram-kanal.md, ye-metodichka-produkty.md, ye-razhor-vadim-kosaryov.md, uroki-i-efiry-konspekty.md, sarkazi-mk-metod.md, sekret-legkogo-kontenta.md, storybrand-miller.md, mini-kurs-pervyy-kontakt-uroki-1-6.md, mini-kurs-v2-polnyy-konspekt.md, kurs-prodazhi-uroki.md, kurs-samoprezentatsiya-polnyy.md, nastavnik-content-strategy-parts123.md, zhigiliy-master-argumenta.md, zhigiliy-master-zvonka.md, natalya-kurs-prodazh.md, tokovinin-tg-kanal.md, rz-vstrecha-g2-final.md, praktikum-zvonki-07-05-26.md, vstrecha-04-05-2026.md, vstrecha-sarkazi-04-05-2026.md

### raw/1-yuri-eremin/
4 ogg-транскрипта 23.04.2026 (авторский надзор, цена постоянному, договор-суды, согласование), Подкаст 1 (позиционирование), фрагменты Практикума по звонкам 07.05.2026

---

## Базовые правила (нельзя нарушать)

1. **Никогда «УТП»** — только смыслы и ценности (см. wiki/concepts/smysly-i-tsennosti.md)
2. **Никогда «возражения»** — только «иные мнения»
3. **Никогда «заказчики», «дизайн-проект», «ремонт», «под ключ», «для вас», «вам»**
4. **Никогда не называть цену в первом контакте**
5. **Никогда не давать скидки > 3%**
6. **Никогда не публиковать без хука в первые 3 секунды**
7. **Каждое обещание — с именем, цифрой, городом из кейсов**
8. **Голос Юрия — тёплый, прямой, без корпоративного холода**
9. **Не использовать «не» в позиционировании**
10. **Цена — только на 15-м шаге встречи (из 17)**

---

## Главные цифры РЗ (для контекста)

- **130 резидентов** | **Цель: 5 000 к январю 2027**
- **5 000 ₽/мес** базовая подписка
- **499 000 ₽** наставничество (Лимон)
- **Отток ~100%** — 🔴 главный блокер
- **Конверсия SaleBot ~1%** | **Цель: >10%**
- **Кодовое слово клуба:** «Реализация» | **Наставничества:** «Лимон»
- **Менеджер продаж:** Татьяна (45-минутный разбор)
- **Big Idea:** «Проектировать вы уже научились — осталось научиться зарабатывать»

---

## Дата последнего обновления: 2026-05-10
## Версия: 2.0 (глубокий проход — все wiki-файлы прочитаны полностью)
