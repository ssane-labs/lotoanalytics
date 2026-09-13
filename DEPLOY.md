# Развёртывание

Три части, независимые друг от друга. Mini App и донаты работают без
последней — Cloudflare нужен только для платной подписки и круглосуточного
бота.

---

## 1. Mini App на GitHub Pages

Уже настроено. Settings → Pages → Source: `Deploy from a branch`, ветка
`main`, папка `/docs`. Адрес: https://ssane-labs.github.io/lotoanalytics/

Каждый push в `main` обновляет приложение автоматически.

---

## 2. Данные тиражей

`.github/workflows/update-data.yml` раз в сутки забирает свежие тиражи и
коммитит их в `docs/data/`. История накапливается в `data/draws_6x45.csv`.

Разовый бэкфилл всей истории: скачайте архив с
https://www.stoloto.ru/6x45/archive и выполните

```bash
python scripts/build_data.py --csv путь/к/архиву.csv
```

---

## 3. Cloudflare Workers — подписка и круглосуточный бот

Зачем это нужно. GitHub Pages раздаёт файлы, а файлы не умеют помнить, кто
заплатил. Нужна маленькая программа, которая всегда запущена, имеет свой
HTTPS-адрес и хранит список подписок. Бесплатного тарифа Cloudflare хватает
с запасом: 100 000 запросов в день, карта при регистрации не требуется.

Терминал и Node.js не нужны — всё делается в браузере.

### 3.1. Создать воркер

1. Зарегистрируйтесь на https://dash.cloudflare.com
2. В левом меню — **Compute (Workers)** → **Create** → **Start with Hello World**
   → задайте имя, например `loto-analytics-bot` → **Deploy**
3. Нажмите **Edit code**
4. Выделите весь код в редакторе и замените содержимым файла
   [`bot/worker.bundle.js`](bot/worker.bundle.js) — это специально собранный
   один файл, копируйте целиком
5. **Deploy**

Запомните адрес воркера — он показан сверху, вида
`https://loto-analytics-bot.ВАШ-ПОДДОМЕН.workers.dev`

### 3.2. Хранилище подписок

1. Левое меню → **Storage & Databases** → **KV** → **Create Instance**
2. Имя: `SUBS` → **Create**
3. Вернитесь в воркер → **Settings** → **Bindings** → **Add** → **KV namespace**
4. Variable name: `SUBS`, выберите созданное хранилище → **Deploy**

Имя переменной обязано быть именно `SUBS` — по нему код обращается к базе.

### 3.3. Переменные и секреты

Воркер → **Settings** → **Variables and Secrets** → **Add**.

Обычные переменные (тип **Text**):

| Имя | Значение |
|---|---|
| `MINIAPP_URL` | `https://ssane-labs.github.io/lotoanalytics/` |
| `DONATE_URL` | `https://boosty.to/fabrix.com/donate` |

Секреты (тип **Secret** — их значение потом не показывается):

| Имя | Значение |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `WEBHOOK_SECRET` | любая длинная случайная строка |

Сгенерировать секрет:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

После добавления — **Deploy**.

### 3.4. Проверить, что воркер жив

Откройте в браузере `https://ВАШ-АДРЕС.workers.dev/health` — должно
ответить `ok`.

### 3.5. Подключить Telegram к воркеру

```bash
export BOT_TOKEN="токен от BotFather"
python bot/setup_telegram.py webhook https://ВАШ-АДРЕС.workers.dev ВАШ_WEBHOOK_SECRET
```

С этого момента бот отвечает сам, круглосуточно, и `bot/local_bot.py`
больше не нужен. Запускать их одновременно нельзя: вебхук и long polling
взаимоисключающи, Telegram отдаёт апдейт кому-то одному.

### 3.6. Включить подписку в приложении

В [`docs/config.js`](docs/config.js) впишите адрес воркера в `WORKER_URL`,
закоммитьте и запушьте. Блок подписки появится в приложении сам.

---

## Автопубликация воркера (чтобы больше не вставлять код руками)

`.github/workflows/deploy-worker.yml` публикует воркер сам при каждом
изменении его исходников. Нужна разовая настройка — два секрета в GitHub:

1. Cloudflare → профиль справа вверху → **Profile** → **API Tokens** →
   **Create Token** → шаблон **Edit Cloudflare Workers** → Create.
   Скопируйте токен сразу: повторно его не покажут.
2. Account ID виден в адресной строке после `dash.cloudflare.com/`
3. GitHub → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**, дважды:
   `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`

После этого правки воркера доезжают в прод сами. Секреты воркера и привязка
KV живут в Cloudflare и этим не затрагиваются.

## Изменение кода воркера

Правьте `bot/worker.js` и `bot/verify.js` — это исходники. Затем

```bash
python bot/build_bundle.py
```

и вставьте обновлённый `bot/worker.bundle.js` в редактор Cloudflare.
CI проверяет, что собранный файл не отстал от исходников.

---

## Оплату нельзя проверить со своего аккаунта

Telegram запрещает владельцу и администраторам бота покупать в собственном
боте — это защита от мошенничества и случайных покупок администратором.
Блокировка молчаливая: счёт открывается и не загружается, ошибки нет нигде,
в приложении приходит статус «отменено».

Симптомы неотличимы от поломки, поэтому: **проверяйте оплату с другого
аккаунта Telegram**. Со своего она не пройдёт никогда, сколько бы звёзд ни
было на балансе.

Приложение подсказывает об этом само, когда счёт закрывается без оплаты.

## Возврат средств

Telegram требует, чтобы бот мог вернуть Stars по запросу пользователя.
Идентификатор платежа сохраняется в KV в поле `charge_id`. Возврат:

```bash
curl -X POST "https://api.telegram.org/bot<ТОКЕН>/refundStarPayment" \
  -H "content-type: application/json" \
  -d '{"user_id": 123456, "telegram_payment_charge_id": "<charge_id>"}'
```

---

## Что где лежит

| Файл | Назначение |
|---|---|
| `bot/worker.js` | исходник воркера: команды, платежи, API |
| `bot/verify.js` | проверка подписи initData |
| `bot/worker.bundle.js` | склейка двух предыдущих для панели Cloudflare |
| `bot/local_bot.py` | бот для локальной отладки, без оплаты |
| `bot/setup_telegram.py` | настройка команд, кнопки меню и вебхука |
| `docs/config.js` | адреса воркера и Boosty |
