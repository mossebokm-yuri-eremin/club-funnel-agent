# Gemini HTTPS-прокси — настройка

Контекст: VPS Beget в РФ → Google AI блокирует API по геолокации
(`FAILED_PRECONDITION: User location is not supported`). Cloudflare WARP free
не помогает (loc=RU остаётся). Решение — HTTPS-прокси из Нидерландов.

Прокси используется **только для Gemini** (картинки Nano Banana + видео-анализ).
Claude / OpenAI / Telegram / Cloudinary / GetCourse ходят напрямую.

---

## 1. Купить прокси

1. Зайди на **proxy6.net** (логин = твоя почта).
2. Раздел "Купить прокси" → выбери:
   - Тип: **HTTPS** (не SOCKS5)
   - Страна: **Netherlands** (`NL`)
   - Срок: **1 месяц** (на пробу; потом продлим)
   - Количество: **1 прокси**
3. Оплати. Цена обычно ~$1.5–3 за 1 прокси/месяц.

## 2. Получить строку конфига

После оплаты в личном кабинете proxy6.net увидишь строку формата:
```
host:port:login:password
```
Пример (значения вымышленные):
```
185.231.204.50:8000:abc123:Xy7zPq9
```

## 3. Преобразовать в URL для .env

Формат URL: `http://login:password@host:port`

Пример:
```
http://abc123:Xy7zPq9@185.231.204.50:8000
```

**Важно:** именно `http://` в начале, даже если прокси HTTPS — это URL схема, а
не протокол прокси-сервера. (HTTPS-туннель через CONNECT на HTTP-прокси — норма.)

Если пароль содержит спецсимволы (`@`, `:`, `/`, `#`, `%`), их надо
URL-encode:
- `@` → `%40`
- `:` → `%3A`
- `/` → `%2F`
- `#` → `%23`
- `%` → `%25`

## 4. Прислать строку агенту

Просто скинь её в чат — агент сам обновит `.env` на VPS и применит.

Куда агент впишет:
```
# /etc/club-funnel/.env
GEMINI_HTTPS_PROXY=http://login:pass@host:port
```

## 5. Применение (агент делает сам)

```bash
# 1. Записать в .env
echo "GEMINI_HTTPS_PROXY=http://login:pass@host:port" | sudo tee -a /etc/club-funnel/.env

# 2. Выключить placeholder режим
sudo sed -i 's/^NANO_BANANA_PLACEHOLDER_MODE=.*/NANO_BANANA_PLACEHOLDER_MODE=false/' /etc/club-funnel/.env

# 3. Рестарт
sudo -u club -H pm2 restart club-funnel-agent --update-env

# 4. Smoke test через diagnostic endpoint
curl -X POST http://127.0.0.1:3000/test/image-gen \
  -H "Authorization: Bearer $TEST_ENDPOINT_TOKEN"
# Ожидаем: {"ok":true,"proxyEnabled":true,"mimeType":"image/png","bytes":N,...}
```

## 6. Если прокси упал

В коде:
- Таймаут 30 сек на каждый Gemini вызов.
- При failure — ошибка `[gemini-proxy] fetch failed via proxy: ...` идёт в лог,
  carousel-worker помечает job как `failed`, **остальной pipeline не падает**.
- Юрий получает уведомление о фейле job через мониторинг (TODO P3).

Откат: поставить `NANO_BANANA_PLACEHOLDER_MODE=true` снова → серые placeholder'ы
вернутся, pipeline продолжит работать без реальных картинок.

## 7. После переезда в Аргентину

Если VPS переедет в страну, где Gemini доступен, прокси можно отключить:
```
GEMINI_HTTPS_PROXY=
```
Код автоматически переключится на прямые запросы (без прокси-диспатчера).
