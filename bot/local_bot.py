"""Локальный бот на long polling — чтобы проверить всё прямо сейчас.

Отличие от bot/worker.js: тот живёт в облаке и работает всегда, а этот
работает, только пока запущен на вашем компьютере. Вебхук ему не нужен,
HTTPS тоже — он сам ходит к Telegram за обновлениями. Идеально для проверки,
не годится как продакшн.

Зависимостей нет, только стандартная библиотека.

Запуск (Windows, PowerShell):
    $env:BOT_TOKEN = "токен от BotFather"
    python bot/local_bot.py

Запуск (bash):
    BOT_TOKEN="токен от BotFather" python bot/local_bot.py

Пока адреса Mini App нет, бот работает без кнопки и честно об этом пишет.
Когда GitHub Pages поднимется, добавьте:
    $env:MINIAPP_URL = "https://ssane-labs.github.io/lotoanalytics/"

Остановить: Ctrl+C
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.telegram.org/bot{token}/{method}"

TEXT = {
    "start": (
        "Это лотерейный аналитик.\n\n"
        "Он не предсказывает результаты тиражей — предсказать их невозможно, "
        "и внутри есть вкладка «Проверка», где это измерено на реальных данных.\n\n"
        "Что он делает вместо этого: считает, насколько часто вашу комбинацию "
        "выбирают другие игроки. Джекпот делится между всеми, кто угадал, "
        "поэтому комбинация, которую не поставил больше никто, при выигрыше "
        "приносит больше денег. Шанс выиграть при этом не меняется."
    ),
    "help": (
        "Команды:\n"
        "/app — открыть аналитику\n"
        "/honest — почему мы не продаём предсказания\n"
        "/help — это сообщение"
    ),
    "honest": (
        "Коротко: шар не помнит прошлых тиражей.\n\n"
        "Модель, обученная на всех прошлых тиражах, сходится ровно к «все "
        "комбинации равновероятны» — 1 к 8 145 060 для «6 из 45». Мы обучили "
        "несколько моделей, включая градиентный бустинг, и проверили их на "
        "тиражах, которых они не видели. Ни одна не обошла случайный выбор "
        "(0,8 совпадения на тираж). Таблица с результатами — во вкладке "
        "«Проверка», код проверки открыт.\n\n"
        "Если кто-то продаёт вам «числа на завтра» — он продаёт случайные числа."
    ),
    "no_app": (
        "\n\nMini App пока не развёрнут: адрес не задан. "
        "Поднимите GitHub Pages и перезапустите бота с переменной MINIAPP_URL."
    ),
    "unknown": "Не знаю такой команды. Попробуйте /help",
}


def call(token: str, method: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        API.format(token=token, method=method),
        data=data,
        headers={"content-type": "application/json"},
    )
    # Long polling держит соединение открытым до 60 секунд, поэтому таймаут
    # должен быть заведомо больше, иначе каждый опрос будет обрываться сам.
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode())


def send(token: str, chat_id: int, text: str, app_url: str | None) -> None:
    payload: dict = {"chat_id": chat_id, "text": text}
    if app_url:
        payload["reply_markup"] = {
            "inline_keyboard": [
                [{"text": "Открыть аналитику", "web_app": {"url": app_url}}]
            ]
        }
    call(token, "sendMessage", payload)


def handle(token: str, message: dict, app_url: str | None) -> None:
    text = message.get("text")
    if not text:
        return
    chat_id = message["chat"]["id"]
    command = text.strip().split()[0].split("@")[0].lower()

    if command == "/start":
        body = TEXT["start"]
        if not app_url:
            body += TEXT["no_app"]
        send(token, chat_id, body, app_url)
    elif command == "/honest":
        send(token, chat_id, TEXT["honest"], app_url)
    elif command == "/help":
        send(token, chat_id, TEXT["help"], None)
    else:
        send(token, chat_id, TEXT["unknown"], None)

    who = message.get("from", {}).get("username") or chat_id
    print(f"  {command} <- @{who}")


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            # line_buffering: иначе при запуске из скрипта вывод копится
            # в буфере и кажется, что бот завис.
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, OSError):
            pass

    token = os.environ.get("BOT_TOKEN", "").strip()
    if not token:
        print(
            "Не задан BOT_TOKEN.\n\n"
            '  PowerShell:  $env:BOT_TOKEN = "токен"\n'
            '  bash:        export BOT_TOKEN="токен"\n\n'
            "Токен берётся у @BotFather. В файлы его не записывайте.",
            file=sys.stderr,
        )
        return 1

    app_url = os.environ.get("MINIAPP_URL", "").strip() or None

    try:
        me = call(token, "getMe")["result"]
    except urllib.error.HTTPError as exc:
        print(f"Telegram отверг токен: {exc.code} {exc.reason}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"Сеть недоступна: {exc}", file=sys.stderr)
        return 1

    # Вебхук и long polling взаимоисключающи: пока висит вебхук, getUpdates
    # возвращает ошибку. Снимаем его на время локальной отладки.
    call(token, "deleteWebhook", {"drop_pending_updates": False})

    print(f"Бот @{me['username']} слушает. Остановить — Ctrl+C.")
    print(f"Mini App: {app_url or 'адрес не задан, кнопки не будет'}\n")

    offset = None
    while True:
        try:
            payload = {"timeout": 50, "allowed_updates": ["message"]}
            if offset is not None:
                payload["offset"] = offset
            result = call(token, "getUpdates", payload)
        except KeyboardInterrupt:
            raise
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            print(f"  сеть моргнула ({exc}), повтор через 3 с")
            time.sleep(3)
            continue

        for update in result.get("result", []):
            offset = update["update_id"] + 1
            message = update.get("message")
            if not message:
                continue
            try:
                handle(token, message, app_url)
            except Exception as exc:  # noqa: BLE001 - один сбойный апдейт не должен ронять бота
                print(f"  ошибка обработки: {exc}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nОстановлен.")
