"""Настройка бота через Telegram Bot API: команды, кнопка Mini App, вебхук.

Заменяет ручные curl-запросы из README. Кириллицу в curl на Windows корёжит
кодировка консоли, поэтому все вызовы идут через Python.

Токен читается из переменной окружения и никуда не записывается:

    $env:BOT_TOKEN = "токен"            # PowerShell
    export BOT_TOKEN="токен"            # bash

Примеры:

    # посмотреть текущее состояние
    python bot/setup_telegram.py status

    # привести список команд к тому, что бот реально умеет
    python bot/setup_telegram.py commands

    # кнопка меню открывает Mini App (нужен рабочий HTTPS-адрес)
    python bot/setup_telegram.py menu https://ssane-labs.github.io/lotoanalytics/

    # подключить облачный воркер
    python bot/setup_telegram.py webhook https://ваш-воркер.workers.dev СЕКРЕТ

    # отключить вебхук (нужно перед запуском local_bot.py)
    python bot/setup_telegram.py unwebhook
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_MINIAPP_URL = "https://ssane-labs.github.io/lotoanalytics/"

# Ровно те команды, которые обработаны в worker.js и local_bot.py.
# Список здесь и обработчики там обязаны совпадать: команда в меню, на которую
# бот отвечает «не знаю такой команды», выглядит как сломанный бот.
COMMANDS = [
    {"command": "start", "description": "Открыть аналитику"},
    {"command": "honest", "description": "Почему предсказать тираж нельзя"},
    {"command": "help", "description": "Что умеет бот"},
]


def call(token: str, method: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data,
        headers={"content-type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode())
    except OSError as exc:
        return {"ok": False, "description": f"сеть недоступна: {exc}"}


def require_ok(result: dict, what: str) -> bool:
    if result.get("ok"):
        print(f"  ok: {what}")
        return True
    print(f"  ОШИБКА ({what}): {result.get('description')}", file=sys.stderr)
    return False


def check_url(url: str) -> bool:
    """Telegram примет только живой HTTPS-адрес, поэтому проверяем заранее."""
    if not url.startswith("https://"):
        print(f"  адрес должен начинаться с https:// — получено {url}", file=sys.stderr)
        return False
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "setup"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            print(f"  адрес отвечает: HTTP {resp.status}")
            return True
    except urllib.error.HTTPError as exc:
        print(f"  адрес отвечает HTTP {exc.code} — Mini App не откроется.", file=sys.stderr)
        if exc.code == 404:
            print(
                "  Похоже, GitHub Pages ещё не включён: Settings -> Pages -> "
                "Source: Deploy from a branch, ветка main, папка /docs.",
                file=sys.stderr,
            )
        return False
    except OSError as exc:
        print(f"  адрес недоступен: {exc}", file=sys.stderr)
        return False


def cmd_status(token: str, _args: list[str]) -> int:
    me = call(token, "getMe")
    if not me.get("ok"):
        print(f"Токен не работает: {me.get('description')}", file=sys.stderr)
        return 1
    bot = me["result"]
    print(f"Бот:      @{bot['username']} ({bot.get('first_name')})")
    print(f"Ссылка:   https://t.me/{bot['username']}")

    hook = call(token, "getWebhookInfo").get("result", {})
    print(f"Вебхук:   {hook.get('url') or 'не задан (бот молчит, если не запущен local_bot.py)'}")
    if hook.get("last_error_message"):
        print(f"          последняя ошибка: {hook['last_error_message']}")
    print(f"Очередь:  {hook.get('pending_update_count', 0)} необработанных апдейтов")

    button = call(token, "getChatMenuButton").get("result", {})
    if button.get("type") == "web_app":
        print(f"Кнопка:   Mini App -> {button.get('web_app', {}).get('url')}")
    else:
        print(f"Кнопка:   {button.get('type')} (Mini App не подключён)")

    cmds = call(token, "getMyCommands").get("result", [])
    print("Команды:")
    for c in cmds or []:
        print(f"          /{c['command']:<8} {c['description']}")
    if not cmds:
        print("          список пуст")
    return 0


def cmd_commands(token: str, _args: list[str]) -> int:
    ok = require_ok(call(token, "setMyCommands", {"commands": COMMANDS}), "список команд обновлён")
    # Отдельный русскоязычный список перекрывает общий, поэтому его чистим.
    call(token, "deleteMyCommands", {"language_code": "ru"})
    return 0 if ok else 1


def cmd_menu(token: str, args: list[str]) -> int:
    url = args[0] if args else DEFAULT_MINIAPP_URL
    print(f"Проверяю {url}")
    if not check_url(url):
        return 1
    result = call(
        token,
        "setChatMenuButton",
        {"menu_button": {"type": "web_app", "text": "Аналитика", "web_app": {"url": url}}},
    )
    return 0 if require_ok(result, "кнопка меню открывает Mini App") else 1


def cmd_webhook(token: str, args: list[str]) -> int:
    if len(args) < 2:
        print("Нужны адрес воркера и секрет: webhook <URL> <СЕКРЕТ>", file=sys.stderr)
        return 2
    url, secret = args[0], args[1]
    result = call(
        token,
        "setWebhook",
        {"url": url, "secret_token": secret, "allowed_updates": ["message"]},
    )
    return 0 if require_ok(result, f"вебхук указывает на {url}") else 1


def cmd_unwebhook(token: str, _args: list[str]) -> int:
    result = call(token, "deleteWebhook", {"drop_pending_updates": False})
    return 0 if require_ok(result, "вебхук снят, можно запускать local_bot.py") else 1


ACTIONS = {
    "status": cmd_status,
    "commands": cmd_commands,
    "menu": cmd_menu,
    "webhook": cmd_webhook,
    "unwebhook": cmd_unwebhook,
}


def main(argv: list[str]) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            # line_buffering: без него stdout копится в буфере и сообщения
            # об ошибках из stderr печатаются раньше своего контекста.
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, OSError):
            pass

    if len(argv) < 2 or argv[1] not in ACTIONS:
        print(__doc__)
        print(f"Доступные действия: {', '.join(ACTIONS)}")
        return 2

    token = os.environ.get("BOT_TOKEN", "").strip()
    if not token:
        print(
            "Не задан BOT_TOKEN.\n"
            '  PowerShell:  $env:BOT_TOKEN = "токен"\n'
            '  bash:        export BOT_TOKEN="токен"',
            file=sys.stderr,
        )
        return 1

    return ACTIONS[argv[1]](token, argv[2:])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
